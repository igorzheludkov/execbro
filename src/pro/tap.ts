import { connectedApps } from "../core/state.js";
import type { CoordinateMissDiagnosis } from "./coordinateMiss.js";
import type { ConnectedApp } from "../core/types.js";
import type { OCRResult, OCRWord } from "../core/ocr.js";
import { executeInApp } from "../core/executor.js";
import { pressElement } from "../core/executor.js";
import {
    iosTap,
    iosFindElement,
    iosScreenshot,
    isUiDriverAvailable,
    getUiDriverInstallHint,
    getIOSSafeAreaTop
} from "../core/ios.js";
import { androidTap, androidFindElement } from "../core/android.js";
import { compareScreenshots } from "./screenshot-diff.js";
import { scanMetroPorts, fetchDevices, selectMainDevice } from "../core/metro.js";
import { connectToDevice, clearReconnectionSuppression, getConnectedAppByDevice } from "../core/connection.js";
import { resolveDeviceTarget, formatResolverError } from "../core/deviceResolver.js";
import { notifyDriverMissing } from "../core/logbox.js";
import { captureFailureArtifact, type ArtifactOutcome, type CaptureSignals } from "../core/failureArtifact.js";
import { diagnoseStaleness, recordScreen, type StalenessVerdict } from "../core/screenStaleness.js";
import {
    captureScreenshot,
    verifyAndCapture,
    burstCaptureAndVerify,
} from "./verifyAction.js";

// --- Types ---

export type TapStrategy = "auto" | "fiber" | "accessibility" | "ocr" | "coordinate";

export interface TapQuery {
    text?: string;
    testID?: string;
    component?: string;
    x?: number;
    y?: number;
}

export interface TapOptions {
    text?: string;
    testID?: string;
    component?: string;
    index?: number;
    x?: number;
    y?: number;
    strategy?: TapStrategy;
    maxTraversalDepth?: number;
    native?: boolean;
    screenshot?: boolean;
    verify?: boolean;
    /**
     * Hold the touch this many milliseconds instead of releasing it immediately.
     * Omitted means a normal tap. RN's onLongPress fires at 500ms.
     */
    duration?: number;
    burst?: boolean;
    /**
     * Target device. Accepts an iOS simulator UDID, an Android adb serial,
     * or a substring matched against connected RN apps / booted simulators /
     * attached Android devices. See deviceResolver.resolveDeviceTarget for
     * the full resolution algorithm.
     */
    device?: string;
}

// outcome categorizes WHY the strategy didn't tap, distinct from `reason` (the raw message):
//   - "not-found": strategy ran to completion and found no match (definitive miss)
//   - "timeout": strategy didn't finish within its budget — result UNKNOWN, do not infer absence
//   - "skipped": strategy was skipped before running (no Metro, no UI driver, budget exhausted)
//   - "invisible": strategy found query-matching elements but none were visible/laid out
//   - "ambiguous": multiple matches and no index= specified
//   - "error": strategy threw or returned an unexpected error
export type TapAttemptOutcome = "not-found" | "timeout" | "skipped" | "invisible" | "ambiguous" | "error";

export interface TapAttempt {
    strategy: string;
    reason: string;
    outcome?: TapAttemptOutcome;
}

export interface TapScreenshot {
    image: string;
    width: number;
    height: number;
    scaleFactor: number;
}

export interface TapVerification {
    // When `skipped` is true, the diff was not computed (verify=false). The other
    // numeric/boolean fields are absent in that case. `explanation` is always present.
    skipped?: boolean;
    skippedReason?: string;
    meaningful?: boolean;
    changeRate?: number;
    changedPixels?: number;
    totalPixels?: number;
    transientChangeDetected?: boolean;
    peakChangeRate?: number;
    peakFrame?: number;
    burstGroupId?: string;
    // Typed verdict for burst analysis (swipe especially):
    //   "settled_elsewhere" — persistent change, the gesture succeeded
    //   "snap_back"         — mid-gesture motion but reverted (content fits viewport, or rejected drop)
    //   "missed"            — no movement at any frame (gesture hit a non-responsive surface)
    // Omitted when not computed (non-burst path, verify=false).
    kind?: "settled_elsewhere" | "snap_back" | "missed";
    explanation: string;
}

export function buildVerificationExplanation(v: {
    meaningful: boolean;
    changeRate: number;
    changedPixels: number;
    totalPixels: number;
    transientChangeDetected?: boolean;
    peakChangeRate?: number;
    peakFrame?: number;
    action?: "tap" | "swipe";
    kind?: "settled_elsewhere" | "snap_back" | "missed";
}): string {
    const pct = (rate: number) => (rate * 100).toFixed(1) + "%";
    const action = v.action ?? "tap";
    const Action = action[0].toUpperCase() + action.slice(1);
    const target = action === "swipe" ? "scroll surface" : "element";

    // Burst path with typed verdict
    if (v.kind === "settled_elsewhere") {
        return `${Action} caused a visible UI change (${pct(v.changeRate)} pixel diff). Something on screen responded; a pixel diff cannot identify which element, so this is not confirmation that the intended target handled it.`;
    }
    if (v.kind === "snap_back") {
        if (action === "swipe") {
            return (
                `Snap-back detected: content moved during the drag (frame ${v.peakFrame} peak ${pct(v.peakChangeRate || 0)} diff) ` +
                `but returned to the starting position. Classic 'content fits inside the viewport' pattern — ` +
                `check contentSize vs layoutSize on the ScrollView, not gesture handling.`
            );
        }
        return (
            `Transient visual feedback detected (frame ${v.peakFrame} peak ${pct(v.peakChangeRate || 0)} diff) ` +
            `but no persistent change. ${Action} triggered a momentary animation that settled back.`
        );
    }
    if (v.kind === "missed") {
        return (
            `No visual change detected — neither persistent nor transient across burst frames. ` +
            `The ${target} may not respond visually or the ${action} may have missed its target.`
        );
    }

    // Legacy non-burst path
    if (v.meaningful) {
        return `${Action} caused a visible UI change (${pct(v.changeRate)} pixel diff). Something on screen responded; a pixel diff cannot identify which element, so this is not confirmation that the intended target handled it.`;
    }
    return (
        `No visual change detected between before and after screenshots. ` +
        `The ${target} may not respond visually or the ${action} may have missed.`
    );
}

export interface BurstAnalysis {
    meaningful: boolean;
    persistentChangeRate: number;
    transientChangeDetected: boolean;
    peakChangeRate: number;
    peakFrame: number;
    framesWithChange: number[];
    kind: "settled_elsewhere" | "snap_back" | "missed";
}

const BURST_CHANGE_THRESHOLD = 0.005;

export async function analyzeBurstFrames(
    frames: Buffer[],
    options?: { statusBarHeight?: number }
): Promise<BurstAnalysis> {
    if (frames.length < 2) {
        return {
            meaningful: false,
            persistentChangeRate: 0,
            transientChangeDetected: false,
            peakChangeRate: 0,
            peakFrame: 0,
            framesWithChange: [],
            kind: "missed"
        };
    }

    let peakChangeRate = 0;
    let peakFrame = 0;
    const framesWithChange: number[] = [];

    for (let i = 1; i < frames.length; i++) {
        const diff = await compareScreenshots(frames[i - 1], frames[i], options);
        if (diff.changeRate > BURST_CHANGE_THRESHOLD) {
            framesWithChange.push(i);
        }
        if (diff.changeRate > peakChangeRate) {
            peakChangeRate = diff.changeRate;
            peakFrame = i;
        }
    }

    const persistentDiff = await compareScreenshots(frames[0], frames[frames.length - 1], options);
    const persistentChangeRate = persistentDiff.changeRate;
    const transientChangeDetected = !persistentDiff.changed && framesWithChange.length > 0;
    // Snap-back (transient motion that reverts) is NOT a successful gesture —
    // the content moved during the drag but returned to its starting position.
    // Callers diagnosing scroll failures need this to read as "didn't work".
    const meaningful = persistentDiff.changed;
    let kind: "settled_elsewhere" | "snap_back" | "missed";
    if (persistentDiff.changed) {
        kind = "settled_elsewhere";
    } else if (transientChangeDetected) {
        kind = "snap_back";
    } else {
        kind = "missed";
    }

    return {
        meaningful,
        persistentChangeRate,
        transientChangeDetected,
        peakChangeRate,
        peakFrame,
        framesWithChange,
        kind
    };
}

/** What a `duration` tap can say about the element it held. */
export interface LongPressReport {
    durationMs: number;
    /**
     * true / false when the fiber strategy inspected the element; null when the
     * strategy that resolved it (accessibility, OCR, coordinates) has no view of
     * the handlers. null means "not knowable here", never "no handler".
     */
    handlerFound: boolean | null;
    warning?: string;
}

/** What a tap on a Switch-like element (onValueChange) actually did to its value. */
export interface SwitchReport {
    before: boolean;
    after: boolean | null;
    changed: boolean | null;
    warning?: string;
}

export interface TapResult {
    success: boolean;
    method?: string;
    query: TapQuery;
    pressed?: string;
    text?: string;
    path?: string | null;
    component?: string | null;
    tappedAt?: { x: number; y: number };
    convertedTo?: { x: number; y: number; unit: string };
    platform?: string;
    device?: string;
    error?: string;
    attempted?: TapAttempt[];
    matches?: Array<{ index: number; component: string; text: string; testID?: string | null; x?: number; y?: number }>;
    ambiguous?: boolean;
    suggestion?: string;
    screenshot?: TapScreenshot;
    verification?: TapVerification;
    warning?: string;
    deviceNote?: string;
    // Failure-artifact signals (populated by captureFailureArtifact when outcome warrants).
    // Forwarded to telemetry blobs 16-20 by the index.ts wrapper.
    artifactKey?: string;
    ocrClosestMatch?: string;
    fiberPressableCount?: string;
    accessibilityMatchCount?: string;
    appRoute?: string;
    /**
     * `screen_changed:navigation` / `screen_changed:inscreen` when this miss was
     * the screen moving under the agent rather than a bad predicate. Rides into
     * telemetry's errorContext, where categorizeError lifts it out of the
     * `validation` bucket so it stops inflating tap's failure rate.
     */
    staleTag?: string;
    /** Present only when `duration` was passed. */
    longPress?: LongPressReport;
    /**
     * Present only when the fiber strategy resolved a Switch-like element. A pixel
     * diff reads identically for a correct toggle and one that flipped the wrong
     * row, so the value is read back and compared instead.
     */
    switch?: SwitchReport;
    /**
     * Why a coordinate tap changed nothing: what occupied the point, whether an
     * overlay covers it, and the nearest reachable pressable with re-tappable
     * coordinates. Populated only on unmeaningful coordinate taps with a live
     * Metro connection.
     */
    missDiagnosis?: CoordinateMissDiagnosis;
}

// --- Helpers ---

/**
 * Describe the hold that was just delivered. `handlerFound` is null wherever the
 * strategy could not look — saying "no handler" on that evidence would be a claim
 * about the app drawn from the tool's own blind spot.
 */
export function buildLongPressReport(args: {
    durationMs: number | undefined;
    hasLongPress?: boolean;
    element?: string;
}): LongPressReport | undefined {
    if (args.durationMs === undefined) return undefined;
    if (args.hasLongPress === undefined) {
        return { durationMs: args.durationMs, handlerFound: null };
    }
    if (args.hasLongPress) {
        return { durationMs: args.durationMs, handlerFound: true };
    }
    const what = args.element ? `<${args.element} />` : "the element";
    return {
        durationMs: args.durationMs,
        handlerFound: false,
        warning:
            `Held for ${args.durationMs}ms, but ${what} has no onLongPress handler — ` +
            `React Native will have fired its onPress on release instead. The gesture was ` +
            `delivered; if you expected a long-press action, it is not wired to this element.`
    };
}

/**
 * Read a Switch-like element's value back after the tap and compare.
 *
 * Re-resolving through pressElement is deliberate reuse: it only measures, never
 * presses, so the same query returns the same element with a fresh value — no
 * second matcher to keep in sync with the first. Costs one fiber walk, and only
 * on the taps that landed on a switch.
 */
export async function buildSwitchReport(args: {
    before: boolean | null | undefined;
    query: TapQuery;
    index?: number;
    device?: string;
    element?: string;
}): Promise<SwitchReport | undefined> {
    if (typeof args.before !== "boolean") return undefined;
    let after: boolean | null = null;
    try {
        const res = await pressElement({
            text: args.query.text,
            testID: args.query.testID,
            component: args.query.component,
            index: args.index,
            device: args.device
        });
        if (res.success && res.result) {
            const parsed = JSON.parse(res.result);
            if (typeof parsed.switchValue === "boolean") after = parsed.switchValue;
        }
    } catch {
        // Read-back failed — after stays null, which reports "unknown", not "unchanged".
    }
    const changed = after === null ? null : after !== args.before;
    const what = args.element ? `<${args.element} />` : "the switch";
    if (changed === false) {
        return {
            before: args.before,
            after,
            changed,
            warning:
                `${what} still reads ${String(after)} after the tap. The gesture was delivered, but the ` +
                `value did not change — a controlled Switch whose parent rejected the new value, a disabled ` +
                `switch, or the tap landed on a neighbouring element.`
        };
    }
    return { before: args.before, after, changed };
}

export function buildQuery(options: TapOptions): TapQuery {
  const query: TapQuery = {};
  if (options.text !== undefined) query.text = options.text;
  if (options.testID !== undefined) query.testID = options.testID;
  if (options.component !== undefined) query.component = options.component;
  if (options.x !== undefined) query.x = options.x;
  if (options.y !== undefined) query.y = options.y;
  return query;
}

/**
 * Check if text contains characters that break Hermes Runtime.evaluate.
 * Standard accented Latin characters (Polish, Vietnamese, French, German, etc.)
 * and Cyrillic work fine in Hermes. Only emoji and special Unicode ranges cause issues.
 */
export function hasProblematicUnicode(text: string): boolean {
  const emojiPattern =
      /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{200D}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]/u;
  return emojiPattern.test(text);
}

export interface OcrMatch {
    text: string;
    tapCenter: { x: number; y: number };
}

function normalizeForMatch(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 2026-05-16: Reconstruct lines from individual OCR words when the engine fragmented a
 * visible phrase across separate word detections. This happens when a leading icon
 * (Google "G", Apple logo, Microsoft squares) disrupts iOS Vision's line-baseline
 * grouping, so "Continue with Google" comes back as three separate words instead of
 * one OCRLine. Without this, findOcrMatch's word/line substring scan misses the phrase.
 *
 * Grouping rule: words whose vertical centers are within half the running median word
 * height land on the same reconstructed line. Words are sorted left-to-right within
 * the line and joined with a single space. Exported for unit tests.
 */
export interface ReconstructedOcrLine {
    text: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    tapCenter: { x: number; y: number };
    words: OCRWord[];
}

export function reconstructLinesFromWords(words: OCRWord[]): ReconstructedOcrLine[] {
    if (!words.length) return [];
    const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
    const groups: OCRWord[][] = [];
    let current: OCRWord[] = [];
    let runningMidY = -Infinity;
    let runningHeight = 0;
    for (const w of sorted) {
        const wMid = (w.bbox.y0 + w.bbox.y1) / 2;
        const wHeight = Math.max(1, w.bbox.y1 - w.bbox.y0);
        const tolerance = Math.min(wHeight, runningHeight || wHeight) * 0.5;
        if (current.length === 0 || Math.abs(wMid - runningMidY) <= tolerance) {
            current.push(w);
            const n = current.length;
            runningMidY = runningMidY === -Infinity ? wMid : (runningMidY * (n - 1) + wMid) / n;
            runningHeight = (runningHeight * (n - 1) + wHeight) / n;
        } else {
            groups.push(current);
            current = [w];
            runningMidY = wMid;
            runningHeight = wHeight;
        }
    }
    if (current.length > 0) groups.push(current);

    return groups.map(group => {
        const sortedWords = [...group].sort((a, b) => a.bbox.x0 - b.bbox.x0);
        const text = sortedWords.map(w => w.text).join(" ");
        const x0 = Math.min(...sortedWords.map(w => w.bbox.x0));
        const y0 = Math.min(...sortedWords.map(w => w.bbox.y0));
        const x1 = Math.max(...sortedWords.map(w => w.bbox.x1));
        const y1 = Math.max(...sortedWords.map(w => w.bbox.y1));
        const tapX = sortedWords.reduce((s, w) => s + w.tapCenter.x, 0) / sortedWords.length;
        const tapY = sortedWords.reduce((s, w) => s + w.tapCenter.y, 0) / sortedWords.length;
        return { text, bbox: { x0, y0, x1, y1 }, tapCenter: { x: tapX, y: tapY }, words: sortedWords };
    });
}

/**
 * Narrow the tap point to just the words that produced the substring match.
 * Without this, a query for "Remotely" against a reconstructed line "Yes Remotely No"
 * would tap at the line's centroid (middle of "Remotely" in this case, but easily wrong
 * for asymmetric layouts). Tracks character offsets through the joined text so we know
 * which constituent words contributed to the matched range.
 */
function refineTapCenterToMatchingWords(
    line: ReconstructedOcrLine,
    normalizedNeedle: string
): { x: number; y: number } {
    const normalizedFull = normalizeForMatch(line.text);
    const startChar = normalizedFull.indexOf(normalizedNeedle);
    if (startChar < 0) return line.tapCenter;
    const endChar = startChar + normalizedNeedle.length;

    let offset = 0;
    const covered: OCRWord[] = [];
    for (const w of line.words) {
        const wNorm = normalizeForMatch(w.text);
        const wordStart = offset;
        const wordEnd = offset + wNorm.length;
        // Word overlaps the matched range
        if (wordEnd > startChar && wordStart < endChar) {
            covered.push(w);
        }
        offset = wordEnd + 1; // +1 for the joining space
    }
    if (covered.length === 0) return line.tapCenter;
    const tapX = covered.reduce((s, w) => s + w.tapCenter.x, 0) / covered.length;
    const tapY = covered.reduce((s, w) => s + w.tapCenter.y, 0) / covered.length;
    return { x: tapX, y: tapY };
}

export function findOcrMatch(ocrResult: OCRResult, query: string): OcrMatch | null {
    const needle = normalizeForMatch(query);
    if (!needle) return null;

    const words = ocrResult.words ?? [];
    const lines = ocrResult.lines ?? [];

    const exactWord = words.find((w) => normalizeForMatch(w.text) === needle);
    if (exactWord) return { text: exactWord.text, tapCenter: exactWord.tapCenter };

    const exactLine = lines.find((l) => normalizeForMatch(l.text) === needle);
    if (exactLine) return { text: exactLine.text, tapCenter: exactLine.tapCenter };

    const substringLine = lines.find((l) => normalizeForMatch(l.text).includes(needle));
    if (substringLine) return { text: substringLine.text, tapCenter: substringLine.tapCenter };

    const substringWord = words.find((w) => normalizeForMatch(w.text).includes(needle));
    if (substringWord) return { text: substringWord.text, tapCenter: substringWord.tapCenter };

    // Fall through to phrases reconstructed from word detections. Tap point is
    // refined to only the words covering the matched substring, so a query for
    // "Continue with Google" inside "[icon] Continue with Google" lands on the
    // text run instead of the line centroid (and won't drift onto the icon).
    const reconstructed = reconstructLinesFromWords(words);
    const exactRecon = reconstructed.find((l) => normalizeForMatch(l.text) === needle);
    if (exactRecon) {
        return { text: exactRecon.text, tapCenter: refineTapCenterToMatchingWords(exactRecon, needle) };
    }
    const substringRecon = reconstructed.find((l) => normalizeForMatch(l.text).includes(needle));
    if (substringRecon) {
        return { text: substringRecon.text, tapCenter: refineTapCenterToMatchingWords(substringRecon, needle) };
    }

    return null;
}

export function getAvailableStrategies(query: TapQuery, strategy: TapStrategy): string[] {
    if (query.x !== undefined && query.y !== undefined) {
        return ["coordinate"];
    }
    if (strategy !== "auto") {
        // Always fallback to OCR for text queries — explicit strategy may miss visible text
        if (query.text && strategy !== "ocr" && strategy !== "coordinate") {
            return [strategy, "ocr"];
        }
        return [strategy];
    }
    if (query.component && !query.text && !query.testID) {
        return ["fiber"];
    }
    if (query.testID && !query.text) {
        return ["accessibility", "fiber"];
    }
    if (query.text) {
        const strategies: string[] = [];
        strategies.push("accessibility");
        if (!hasProblematicUnicode(query.text)) {
            strategies.push("fiber");
        }
        strategies.push("ocr");
        return strategies;
    }
    return ["fiber", "accessibility", "ocr"];
}

/**
 * Convert screenshot image coordinates to platform-native tap coordinates.
 *
 * For iOS: screenshot pixels → device pixels (undo downscale) → points (÷ DPR)
 * For Android: screenshot pixels → device pixels (undo downscale)
 *
 * IMPORTANT: Only use this for EXTERNAL coordinates from screenshots.
 * Internal strategies (OCR, accessibility, fiber) produce tap-ready coordinates
 * and call iosTap/androidTap directly — they must NOT go through this function.
 */
export function convertScreenshotToTapCoords(
    pixelX: number,
    pixelY: number,
    platform: "ios" | "android",
    devicePixelRatio: number,
    scaleFactor: number = 1
): { x: number; y: number } {
    const deviceX = pixelX * scaleFactor;
    const deviceY = pixelY * scaleFactor;

    if (platform === "android") {
        return { x: Math.round(deviceX), y: Math.round(deviceY) };
    }

    return {
        x: Math.round(deviceX / devicePixelRatio),
        y: Math.round(deviceY / devicePixelRatio)
    };
}

/** @deprecated Use convertScreenshotToTapCoords instead */
export const convertPixelsToPoints = convertScreenshotToTapCoords;

export type SwipeDirection = "up" | "down" | "left" | "right";

/**
 * Vertical band a direction-based gesture may touch, in the same pixel space as the
 * gesture itself. Insets are the system bars' reach, not their drawn height.
 */
export interface SwipeSafeBand {
    /** Pixels to keep clear at the top (status bar / notch). */
    top: number;
    /** Pixels to keep clear at the bottom (navigation bar / home-gesture strip). */
    bottom: number;
}

/**
 * Extra clearance beyond the navigation bar's reported frame.
 *
 * On a gesture-navigation device the home strip claims touches that START inside it, and
 * its touchable region runs past the drawn bar. A gesture that begins there is taken by
 * the system: the app goes to the background, the tool still reports success, and the next
 * tap — aimed with coordinates captured before the swipe — lands on the launcher. On a
 * personal phone that can open anything.
 *
 * Costing a few percent of travel is the right trade against losing the app entirely.
 */
export const SWIPE_SYSTEM_BAR_MARGIN_PX = 24;

/**
 * Turn a swipe direction (+ optional pixel distance) into screenshot-pixel
 * start/end coordinates, centered on the screen. Content-scroll semantics:
 * "up" = finger travels bottom→top, revealing content below.
 * Distance defaults to 33% of the relevant axis and endpoints clamp to the
 * 10%–90% margin so the gesture never runs off-screen. Exact travel length is
 * preserved; for odd distances the band may sit ≤1px off the axis midpoint.
 */
export function computeSwipeFromDirection(
    direction: SwipeDirection,
    distance: number | undefined,
    width: number,
    height: number,
    safeBand?: SwipeSafeBand
): { startX: number; startY: number; endX: number; endY: number } {
    const vertical = direction === "up" || direction === "down";
    const axis = vertical ? height : width;
    const d = distance && distance > 0 ? distance : Math.round(0.33 * axis);

    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    // The 10%/90% margin keeps a gesture on screen; the safe band keeps it out of the
    // system's hands. Both apply, and the stricter one wins — on a tall device 10% of the
    // axis already clears the nav strip, but a caller-supplied `distance` large enough to
    // push the endpoints outward, or a short/dense screen, does not.
    let lo = Math.round(0.1 * axis);
    let hi = Math.round(0.9 * axis);
    if (vertical && safeBand) {
        lo = Math.max(lo, Math.round(safeBand.top));
        hi = Math.min(hi, Math.round(height - safeBand.bottom));
        // A band that swallows the whole axis (tiny screen, huge insets) would invert the
        // range and produce a nonsense gesture. Fall back to the plain margin rather than
        // emitting start > end.
        if (hi <= lo) {
            lo = Math.round(0.1 * axis);
            hi = Math.round(0.9 * axis);
        }
    }

    // Center a band of length d on the axis midpoint, then clamp to [lo, hi].
    const mid = Math.round(axis / 2);
    const half = Math.floor(d / 2);
    let far = mid - half;        // smaller-coordinate end
    let near = far + d;          // exact length d
    if (near > hi) { near = hi; far = near - d; }
    if (far < lo) { far = lo; near = far + d; }
    // distance exceeds the available span — collapse to the full margin
    if (near > hi) near = hi;
    if (far < lo) far = lo;

    switch (direction) {
        case "up": // finger bottom→top: start at larger Y, end at smaller Y
            return { startX: cx, startY: near, endX: cx, endY: far };
        case "down": // finger top→bottom
            return { startX: cx, startY: far, endX: cx, endY: near };
        case "left": // finger right→left
            return { startX: near, startY: cy, endX: far, endY: cy };
        case "right": // finger left→right
            return { startX: far, startY: cy, endX: near, endY: cy };
    }
}

export function formatTapSuccess(data: {
    method: string;
    query: TapQuery;
    pressed?: string;
    text?: string;
    path?: string | null;
    component?: string | null;
    tappedAt?: { x: number; y: number };
    convertedTo?: { x: number; y: number; unit: string };
    platform?: string;
    device?: string;
    deviceNote?: string;
    screenshot?: TapScreenshot;
    verification?: TapVerification;
}): TapResult {
    const { screenshot, verification, ...rest } = data;
    // I3 (2026-05-16): when the tap landed on a TextInput-like element and the diff
    // reports no visual change, that does NOT mean the focus failed. iOS simulators with
    // the hardware keyboard connected (Cmd+K) suppress the on-screen keyboard, so the
    // input is focused but the screen looks identical. Surface this so the agent doesn't
    // assume the tap missed and retry the wrong thing.
    const isTextInputComponent = (() => {
        const name = data.component ?? data.pressed ?? "";
        return /textfield|textinput|edittext|searchfield/i.test(name);
    })();
    const note = verification && !verification.skipped && verification.meaningful === false && isTextInputComponent
        ? "TextInput focused but no visual change detected. If the simulator has a hardware keyboard connected (Cmd+K), the software keyboard is suppressed even though the input is focused — proceed with text entry via input_text."
        : undefined;
    return {
        success: true,
        ...rest,
        ...(verification && { verification }),
        ...(screenshot && { screenshot }),
        ...(note && { warning: note })
    };
}

export function formatTapFailure(data: {
    query: TapQuery;
    error?: string;
    attempted: TapAttempt[];
    suggestion: string;
    device?: string;
    matches?: Array<{ index: number; component: string; text: string; testID?: string | null; x?: number; y?: number }>;
    ambiguous?: boolean;
    screenshot?: TapScreenshot;
    verification?: TapVerification;
}): TapResult {
    const errorMsg = data.error || buildErrorMessage(data.query);
    const warning =
        data.verification && !data.verification.skipped && data.verification.meaningful === false
            ? "Tap executed but no visual change detected. The element may not exist at these coordinates. Examine the screenshot to verify and retry with adjusted coordinates."
            : undefined;
    const lastStrategy = data.attempted.length > 0 ? data.attempted[data.attempted.length - 1].strategy : undefined;
    return {
        success: false,
        method: lastStrategy,
        query: data.query,
        error: errorMsg,
        attempted: data.attempted,
        suggestion: data.suggestion,
        matches: data.matches,
        ...(data.ambiguous && { ambiguous: true }),
        ...(data.device && { device: data.device }),
        ...(data.verification && { verification: data.verification }),
        ...(data.screenshot && { screenshot: data.screenshot }),
        ...(warning && { warning })
    };
}

function buildErrorMessage(query: TapQuery): string {
  const parts: string[] = [];
  if (query.text) parts.push(`text="${query.text}"`);
  if (query.testID) parts.push(`testID="${query.testID}"`);
  if (query.component) parts.push(`component="${query.component}"`);
  return `No element found matching ${parts.join(", ")}`;
}

// I2 (2026-05-16): RN component composition routinely produces N matches at the same
// coordinates for the same testID/text (e.g. ThemedButton → TouchableOpacity → TouchableOpacity).
// The C1 ambiguity guard refuses all such taps and demands `index=`. That's correct in the
// spatial-ambiguity case (two distinct buttons share a label) but wrong in the
// wrapper-ambiguity case — there's only one logical button, just stacked components.
//
// Collapse matches that share the same (testID, text) and overlap geometrically
// (centers within TOLERANCE_PX). Keeps the first occurrence — fiber/a11y walks parent-first,
// so the outermost wrapper survives (its onPress almost always proxies to inner handlers).
// Spatial ambiguity (different x/y) is preserved and continues to surface the C1 refusal.
function collapseGeometricallyEquivalentMatches<T>(
    matches: T[],
    getCenter: (m: T) => { x: number | undefined; y: number | undefined },
    getKey: (m: T) => string
): T[] {
    if (matches.length <= 1) return matches;
    const TOLERANCE_PX = 2;
    const out: T[] = [];
    for (const m of matches) {
        const mc = getCenter(m);
        const mk = getKey(m);
        const isDuplicate = out.some(o => {
            if (getKey(o) !== mk) return false;
            const oc = getCenter(o);
            return Math.abs((mc.x ?? 0) - (oc.x ?? 0)) <= TOLERANCE_PX &&
                   Math.abs((mc.y ?? 0) - (oc.y ?? 0)) <= TOLERANCE_PX;
        });
        if (!isDuplicate) out.push(m);
    }
    return out;
}

// --- Strategy Result ---

interface StrategyResult {
    success: boolean;
    reason: string;
    pressed?: string;
    text?: string;
    path?: string | null;
    component?: string | null;
    matches?: Array<{ index: number; component: string; text: string; testID?: string | null; x?: number; y?: number }>;
    ambiguous?: boolean;
    convertedTo?: { x: number; y: number; unit: string };
    /** Fiber only: whether the resolved element actually has an onLongPress handler. */
    hasLongPress?: boolean;
    /** Fiber only: the Switch-like element's value BEFORE the tap. null when not a switch. */
    switchValue?: boolean | null;
}

export interface EvidenceSink {
    fiber: {
        ran: boolean;
        durationMs: number;
        metroConnected: boolean;
        pressables: Array<{
            label?: string;
            testID?: string;
            componentName?: string;
            bounds?: { x: number; y: number; width: number; height: number };
        }>;
    };
    accessibility: {
        ran: boolean;
        durationMs: number;
        elements: Array<{
            label?: string;
            testID?: string;
            frame?: { x: number; y: number; width: number; height: number };
        }>;
    };
    ocr: {
        ran: boolean;
        durationMs: number;
        detections: Array<{
            text: string;
            bbox: [number, number, number, number];
            conf: number;
        }>;
        closestMatch: { text: string; score: number } | null;
        /**
         * The best OCR candidate found, with tap-ready coordinates and the
         * scale factor used to capture the screenshot. Set as soon as
         * findOcrMatch resolves, BEFORE any tap-execution code runs, so the
         * orchestrator can recover from a 30ms-late OCR strategy timeout when
         * the candidate score is high enough (Step 2 in 2026-05-15 plan).
         */
        bestCandidate: {
            text: string;
            score: number;
            tapCenter: { x: number; y: number };
            scaleFactor: number;
        } | null;
    };
}

export function makeEmptyEvidenceSink(): EvidenceSink {
    return {
        fiber: { ran: false, durationMs: 0, metroConnected: false, pressables: [] },
        accessibility: { ran: false, durationMs: 0, elements: [] },
        ocr: { ran: false, durationMs: 0, detections: [], closestMatch: null, bestCandidate: null }
    };
}

function ocrSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    // Dice coefficient over character bigrams (case/space-insensitive)
    const bigrams = (s: string): Map<string, number> => {
        const m = new Map<string, number>();
        if (s.length < 2) {
            if (s) m.set(s, 1);
            return m;
        }
        for (let i = 0; i < s.length - 1; i++) {
            const bg = s.slice(i, i + 2);
            m.set(bg, (m.get(bg) ?? 0) + 1);
        }
        return m;
    };
    const ag = bigrams(a);
    const bg = bigrams(b);
    let intersection = 0;
    for (const [k, va] of ag) {
        const vb = bg.get(k);
        if (vb) intersection += Math.min(va, vb);
    }
    const total = Array.from(ag.values()).reduce((s, v) => s + v, 0)
        + Array.from(bg.values()).reduce((s, v) => s + v, 0);
    if (!total) return 0;
    return (2 * intersection) / total;
}

export function findClosestOcrText(
    ocrResult: OCRResult,
    query: string
): { text: string; score: number } | null {
    if (!query) return null;
    const needle = normalizeForMatch(query);
    if (!needle) return null;
    const candidates: Array<{ text: string }> = [];
    if (ocrResult?.words?.length) candidates.push(...ocrResult.words.map(w => ({ text: w.text })));
    if (ocrResult?.lines?.length) candidates.push(...ocrResult.lines.map(l => ({ text: l.text })));
    // Include reconstructed phrases so the diagnostic surfaces "Continue with Google@1.00"
    // instead of "Continue@0.54" when the engine fragmented a multi-word phrase into
    // separate word detections.
    if (ocrResult?.words?.length) {
        candidates.push(...reconstructLinesFromWords(ocrResult.words).map(l => ({ text: l.text })));
    }
    if (!candidates.length) return null;
    let best: { text: string; score: number } | null = null;
    for (const c of candidates) {
        const norm = normalizeForMatch(c.text);
        if (!norm) continue;
        const score = ocrSimilarity(needle, norm);
        if (!best || score > best.score) best = { text: c.text, score };
    }
    return best;
}

// --- Strategy Functions ---

async function tryFiberStrategy(query: TapQuery, index?: number, maxTraversalDepth?: number, sink?: EvidenceSink, device?: string, longPress = false): Promise<StrategyResult> {
    if (sink) {
        sink.fiber.ran = true;
        sink.fiber.metroConnected = connectedApps.size > 0;
    }
    const startedAt = Date.now();
    try {
        // Retry with increasing depth if the initial traversal finds nothing
        const baseDepth = maxTraversalDepth ?? 15;
        const depthAttempts = [baseDepth];
        // Only add deeper retries if user didn't explicitly set a high depth
        if (baseDepth <= 15) {
            depthAttempts.push(30, 45);
        } else if (baseDepth <= 30) {
            depthAttempts.push(baseDepth * 2);
        }

        let lastResult: StrategyResult | null = null;

        for (const depth of depthAttempts) {
            const result = await tryFiberAtDepth(query, index, depth, device, longPress);
            if (sink && result.matches?.length) {
                sink.fiber.pressables = result.matches.slice(0, 50).map(m => ({
                    label: m.text || undefined,
                    testID: m.testID ?? undefined,
                    componentName: m.component,
                    bounds: (m.x !== undefined && m.y !== undefined)
                        ? { x: m.x, y: m.y, width: 0, height: 0 }
                        : undefined
                }));
            }
            if (result.success || result.matches) {
                return result;
            }
            lastResult = result;
        }

        return lastResult!;
    } finally {
        if (sink) sink.fiber.durationMs = Date.now() - startedAt;
    }
}

async function tryFiberAtDepth(
    query: TapQuery,
    index: number | undefined,
    maxTraversalDepth: number,
    device?: string,
    longPress = false
): Promise<StrategyResult> {
    try {
        const result = await pressElement({
            text: query.text,
            testID: query.testID,
            component: query.component,
            index,
            maxTraversalDepth,
            device,
            longPress
        });

        if (!result.success) {
            return { success: false, reason: result.error || "pressElement failed" };
        }

        if (!result.result) {
            return { success: false, reason: "No result from pressElement" };
        }

        const parsed = JSON.parse(result.result);

        if (parsed.error) {
            const strategyResult: StrategyResult = {
                success: false,
                reason: parsed.error
            };
            if (parsed.matches) {
                strategyResult.matches = parsed.matches;
            }
            return strategyResult;
        }

        // Fiber finds the element by text/testID/component, then measures its
        // host component's screen position for a native tap. This ensures the tap
        // goes through React's event pipeline, executing any onPress wrappers
        // (analytics, debouncing, state tracking) inside the component.
        if (parsed.needsNativeTap) {
            // Ambiguity guard: if multiple elements match and the caller didn't
            // specify an explicit index, refuse to tap and surface the full list
            // so the agent can pick the right one.
            if ((parsed.totalMatches ?? 1) > 1 && index === undefined) {
                // I2: collapse geometrically-identical wrapper matches before refusing.
                const collapsed = collapseGeometricallyEquivalentMatches<{
                    index: number; component: string; text: string; testID?: string | null; x?: number; y?: number;
                }>(
                    parsed.allMatches ?? [],
                    (m) => ({ x: m.x, y: m.y }),
                    (m) => `${m.testID ?? ""}::${m.text ?? ""}`
                );
                if (collapsed.length > 1) {
                    return {
                        success: false,
                        reason: `Ambiguous: ${collapsed.length} elements match this query — use index= to pick one`,
                        matches: collapsed,
                        ambiguous: true
                    };
                }
                // Collapsed to one logical element — fall through and tap. The JS-side
                // search already picked allMatches[0] (the outermost wrapper) for
                // parsed.pressed/parsed.nativeTapTarget.
            }
            const elementType = parsed.isInput ? "input element" : "pressable element";
            if (parsed.nativeTapTarget && parsed.nativeTapTarget.x && parsed.nativeTapTarget.y) {
                return {
                    success: false,
                    reason: `Found ${parsed.pressed} (${elementType}) — measured coordinates for native tap`,
                    pressed: parsed.pressed,
                    text: parsed.text,
                    path: parsed.path || null,
                    component: parsed.pressed || null,
                    convertedTo: {
                        x: parsed.nativeTapTarget.x,
                        y: parsed.nativeTapTarget.y,
                        unit: parsed.nativeTapTarget.unit || "points"
                    },
                    hasLongPress: !!parsed.hasLongPress,
                    switchValue: parsed.switchValue ?? null
                };
            }
            return {
                success: false,
                reason: `Found ${parsed.pressed} (${elementType}) but could not measure coordinates — falling through to next strategy`
            };
        }

        // All elements now use needsNativeTap — this shouldn't be reached
        return {
            success: false,
            reason: "Unexpected: element did not request native tap"
        };
    } catch (err) {
        return {
            success: false,
            reason: `Fiber strategy error: ${err instanceof Error ? err.message : String(err)}`
        };
    }
}

async function tryAccessibilityStrategy(
    query: TapQuery,
    index: number | undefined,
    platform: "ios" | "android",
    udid?: string,
    sink?: EvidenceSink,
    signal?: AbortSignal,
    deviceId?: string,
    duration?: number
): Promise<StrategyResult> {
    if (sink) sink.accessibility.ran = true;
    const startedAt = Date.now();
    try {
        const hasTestID = !!query.testID;
        const hasText = !!query.text;

        if (!hasTestID && !hasText) {
            return {
                success: false,
                reason: "No text or testID for accessibility search"
            };
        }

        if (platform === "ios") {
            // One accessibility dump serves every pass below: `axe describe-ui`
            // costs ~210ms and the screen cannot change between predicates, so
            // re-fetching per pass was pure overhead (2-3 dumps per tap).
            const { iosGetUITree } = await import("../core/ios.js");
            const tree = await iosGetUITree(udid);

            // iOS: testID maps to accessibilityIdentifier — search by identifier first,
            // then fall back to labelContains for text-based searches
            let result;
            if (hasTestID && !hasText) {
                // Try exact identifier match first (testID → accessibilityIdentifier)
                result = await iosFindElement(
                    {
                        identifier: query.testID,
                        index
                    },
                    udid,
                    tree
                );
                // Fall back to identifierContains if exact match fails
                if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                    result = await iosFindElement(
                        {
                            identifierContains: query.testID,
                            index
                        },
                        udid,
                        tree
                    );
                }
                // Last resort: try labelContains in case testID is reflected in label
                if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                    result = await iosFindElement(
                        {
                            labelContains: query.testID,
                            index
                        },
                        udid,
                        tree
                    );
                }
            } else {
                const searchText = query.text!;
                // Exact label match first to avoid matching dialog titles like "Clear All"
                // when the query is a single word that happens to be a substring ("Clear").
                result = await iosFindElement(
                    {
                        label: searchText,
                        index
                    },
                    udid,
                    tree
                );
                if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                    result = await iosFindElement(
                        {
                            labelContains: searchText,
                            index
                        },
                        udid,
                        tree
                    );
                }
            }

            if (sink && result.allMatches?.length) {
                sink.accessibility.elements = result.allMatches.slice(0, 50).map(el => ({
                    label: el.label || undefined,
                    testID: el.identifier || undefined,
                    frame: el.frame
                        ? { x: el.frame.x, y: el.frame.y, width: el.frame.width, height: el.frame.height }
                        : undefined
                }));
            }

            if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                return {
                    success: false,
                    reason: result.error ?? "No iOS accessibility match"
                };
            }

            // Ambiguity guard: when the predicate matches multiple a11y elements
            // (e.g. text="My Events" hits both the header title AND the bottom tab),
            // refuse to tap without an explicit index — picking allMatches[0] silently
            // landed on non-interactive header elements in production telemetry.
            // Mirrors the fiber-strategy guard further up the file.
            // I2: collapse geometrically-identical wrapper matches before refusing.
            const iosEffectiveMatches = result.allMatches.length > 1
                ? collapseGeometricallyEquivalentMatches(
                    result.allMatches,
                    (m) => ({ x: m.center?.x, y: m.center?.y }),
                    (m) => `${m.identifier ?? ""}::${m.label ?? ""}`
                )
                : result.allMatches;

            if (iosEffectiveMatches.length > 1 && index === undefined) {
                return {
                    success: false,
                    reason: `Ambiguous: ${iosEffectiveMatches.length} elements match this query — use index= to pick one`,
                    matches: iosEffectiveMatches.map((m, i) => ({
                        index: i,
                        component: m.type ?? "",
                        text: m.label ?? "",
                        testID: m.identifier ?? null,
                        x: m.center?.x,
                        y: m.center?.y
                    })),
                    ambiguous: true
                };
            }

            const match = iosEffectiveMatches[index ?? 0];
            if (!match) {
                return {
                    success: false,
                    reason: `Index ${index} out of bounds (${iosEffectiveMatches.length} matches)`
                };
            }

            await iosTap(match.center.x, match.center.y, { udid, duration });

            return {
                success: true,
                reason: "Tapped via iOS accessibility",
                pressed: match.label || match.type,
                text: match.label || undefined,
                component: match.type || null,
                convertedTo: { x: match.center.x, y: match.center.y, unit: "points" }
            };
        } else {
            // Android: testID maps to resource-id, text maps to text content
            const searchOptions: {
                textContains?: string;
                resourceId?: string;
                contentDescContains?: string;
                index?: number;
            } = { index };

            if (hasTestID && !hasText) {
                searchOptions.resourceId = query.testID;
            } else if (hasText) {
                searchOptions.textContains = query.text;
            }

            // Same single-dump reuse as iOS above — a uiautomator hierarchy dump
            // is the most expensive step of an Android accessibility tap.
            const { androidGetUITree } = await import("../core/android.js");
            const androidTree = await androidGetUITree(deviceId, signal);

            let result = await androidFindElement(searchOptions, deviceId, signal, androidTree);

            // If testID search via resourceId failed, try contentDescContains
            // (older RN versions map testID to content-description)
            if (hasTestID && !hasText && (!result.success || !result.allMatches || result.allMatches.length === 0)) {
                result = await androidFindElement({
                    contentDescContains: query.testID,
                    index
                }, deviceId, signal, androidTree);
            }

            if (sink && result.allMatches?.length) {
                sink.accessibility.elements = result.allMatches.slice(0, 50).map(el => ({
                    label: el.text || el.contentDesc || undefined,
                    testID: el.resourceId || undefined,
                    frame: el.bounds
                        ? { x: el.bounds.left, y: el.bounds.top, width: el.bounds.width, height: el.bounds.height }
                        : undefined
                }));
            }

            if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                return {
                    success: false,
                    reason: result.error ?? "No Android accessibility match"
                };
            }

            // Ambiguity guard — see iOS branch above for rationale.
            // I2: collapse geometrically-identical wrapper matches before refusing.
            const androidEffectiveMatches = result.allMatches.length > 1
                ? collapseGeometricallyEquivalentMatches(
                    result.allMatches,
                    (m) => ({ x: m.center?.x, y: m.center?.y }),
                    (m) => `${m.resourceId ?? ""}::${m.text ?? m.contentDesc ?? ""}`
                )
                : result.allMatches;

            if (androidEffectiveMatches.length > 1 && index === undefined) {
                return {
                    success: false,
                    reason: `Ambiguous: ${androidEffectiveMatches.length} elements match this query — use index= to pick one`,
                    matches: androidEffectiveMatches.map((m, i) => ({
                        index: i,
                        component: m.className ?? "",
                        text: m.text ?? m.contentDesc ?? "",
                        testID: m.resourceId ?? null,
                        x: m.center?.x,
                        y: m.center?.y
                    })),
                    ambiguous: true
                };
            }

            const match = androidEffectiveMatches[index ?? 0];
            if (!match) {
                return {
                    success: false,
                    reason: `Index ${index} out of bounds (${androidEffectiveMatches.length} matches)`
                };
            }

            const a11yTap = await androidTap(match.center.x, match.center.y, deviceId, duration);
            if (!a11yTap.success) {
                return {
                    success: false,
                    reason: `Accessibility found "${match.text ?? match.contentDesc ?? match.resourceId}" but tap failed: ${a11yTap.error}`
                };
            }

            return {
                success: true,
                reason: "Tapped via Android accessibility",
                pressed: match.text || match.className || undefined,
                text: match.text || undefined,
                component: match.className || undefined,
                convertedTo: { x: match.center.x, y: match.center.y, unit: "pixels" }
            };
        }
    } catch (err) {
        return {
            success: false,
            reason: `Accessibility strategy error: ${err instanceof Error ? err.message : String(err)}`
        };
    } finally {
        if (sink) sink.accessibility.durationMs = Date.now() - startedAt;
    }
}

/**
 * Run OCR sense (capture + recognize + match) and tap the match. Also records
 * `sink.ocr.bestCandidate` (matched text + tap coords) into the evidence sink,
 * which is serialized into the R2 failure bundle for diagnostics.
 */
async function tryOcrStrategy(query: TapQuery, platform: "ios" | "android", udid?: string, sink?: EvidenceSink, signal?: AbortSignal, deviceId?: string, duration?: number): Promise<StrategyResult> {
    if (sink) sink.ocr.ran = true;
    const ocrStartedAt = Date.now();
    try {
        const searchText = query.text;
        if (!searchText) {
            return { success: false, reason: "OCR strategy requires text query" };
        }

        let imageBuffer: Buffer;
        let scaleFactor = 1;

        if (platform === "ios") {
            const screenshot = await iosScreenshot(undefined, udid);
            if (!screenshot.success || !screenshot.data) {
                return {
                    success: false,
                    reason: "Failed to capture iOS screenshot for OCR"
                };
            }
            imageBuffer = screenshot.data;
            scaleFactor = screenshot.scaleFactor ?? 1;
        } else {
            const { androidScreenshot } = await import("../core/android.js");
            const screenshot = await androidScreenshot(undefined, deviceId, signal);
            if (!screenshot.success || !screenshot.data) {
                return {
                    success: false,
                    reason: "Failed to capture Android screenshot for OCR"
                };
            }
            imageBuffer = screenshot.data;
            scaleFactor = screenshot.scaleFactor ?? 1;
        }

        const { recognizeText } = await import("../core/ocr.js");
        const ocrResult = await recognizeText(imageBuffer, {
            scaleFactor,
            platform,
            signal
        });

        if (sink && ocrResult) {
            const allDetections = [
                ...(ocrResult.words ?? []),
                ...(ocrResult.lines ?? [])
            ];
            sink.ocr.detections = allDetections.slice(0, 100).map(r => ({
                text: r.text,
                bbox: [r.bbox.x0, r.bbox.y0, r.bbox.x1 - r.bbox.x0, r.bbox.y1 - r.bbox.y0] as [number, number, number, number],
                conf: r.confidence ?? 0
            }));
            sink.ocr.closestMatch = findClosestOcrText(ocrResult, searchText);
        }

        const match = findOcrMatch(ocrResult, searchText);

        // Record the best candidate (matched text + tap coords) into the
        // evidence sink. This is serialized into the R2 failure bundle and is
        // useful when diagnosing OCR taps (e.g. OCR found the match at these
        // coords but the tap didn't register a visual change).
        if (sink && match) {
            const closest = sink.ocr.closestMatch;
            sink.ocr.bestCandidate = {
                text: match.text,
                score: closest && closest.text === match.text ? closest.score : 1,
                tapCenter: { x: match.tapCenter.x, y: match.tapCenter.y },
                scaleFactor
            };
        }

        if (!match) {
            return {
                success: false,
                reason: `OCR did not find text "${searchText}" on screen`
            };
        }

        if (platform === "ios") {
            // tapCenter is in image-pixel space (downscaled) — convert to points
            const { getDevicePixelRatio } = await import("../core/ios.js");
            const dpr = await getDevicePixelRatio(udid);
            const tapResult = await iosTap(
                Math.round((match.tapCenter.x * scaleFactor) / dpr),
                Math.round((match.tapCenter.y * scaleFactor) / dpr),
                { udid, duration }
            );
            if (!tapResult.success) {
                return {
                    success: false,
                    reason: `OCR found "${match.text}" but tap failed: ${tapResult.error}`
                };
            }
        } else {
            // Android: image-pixel → device-pixel (undo downscale), ADB accepts pixels
            const ocrTap = await androidTap(
                Math.round(match.tapCenter.x * scaleFactor),
                Math.round(match.tapCenter.y * scaleFactor),
                deviceId,
                duration
            );
            if (!ocrTap.success) {
                return {
                    success: false,
                    reason: `OCR found "${match.text}" but tap failed: ${ocrTap.error}`
                };
            }
        }

        return {
            success: true,
            reason: "Tapped via OCR text recognition",
            text: match.text,
            convertedTo: {
                x: match.tapCenter.x,
                y: match.tapCenter.y,
                unit: "pixels"
            }
        };
    } catch (err) {
        return {
            success: false,
            reason: `OCR strategy error: ${err instanceof Error ? err.message : String(err)}`
        };
    } finally {
        if (sink) sink.ocr.durationMs = Date.now() - ocrStartedAt;
    }
}

async function tryCoordinateStrategy(
    pixelX: number,
    pixelY: number,
    platform: "ios" | "android",
    lastScreenshot?: {
        originalWidth: number;
        originalHeight: number;
        scaleFactor: number;
    },
    udid?: string,
    deviceId?: string,
    duration?: number
): Promise<StrategyResult> {
    try {
        if (platform === "ios") {
            const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
            const { getDevicePixelRatio } = await import("../core/ios.js");
            // Reuse the caller's frame dimensions when it has them, so the first
            // coordinate tap of a session doesn't pay for an extra screenshot.
            const dprHint = lastScreenshot && lastScreenshot.originalWidth > 0 && lastScreenshot.originalHeight > 0
                ? { width: lastScreenshot.originalWidth, height: lastScreenshot.originalHeight }
                : undefined;
            const devicePixelRatio = await getDevicePixelRatio(udid, dprHint);

            const converted = convertScreenshotToTapCoords(pixelX, pixelY, "ios", devicePixelRatio, scaleFactor);
            const tapResult = await iosTap(converted.x, converted.y, { udid, duration });
            if (!tapResult.success) {
                return {
                    success: false,
                    reason: `Coordinate tap failed: ${tapResult.error}`
                };
            }

            return {
                success: true,
                reason: "Tapped at coordinates (iOS)",
                convertedTo: { x: converted.x, y: converted.y, unit: "points" }
            };
        } else {
            const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
            const converted = convertScreenshotToTapCoords(pixelX, pixelY, "android", 1, scaleFactor);
            // The result is checked, not discarded: an unchecked failure here
            // reported success for a tap adb never delivered.
            const coordTap = await androidTap(converted.x, converted.y, deviceId, duration);
            if (!coordTap.success) {
                return {
                    success: false,
                    reason: `Coordinate tap failed: ${coordTap.error}`
                };
            }

            return {
                success: true,
                reason: "Tapped at coordinates (Android)",
                convertedTo: { x: converted.x, y: converted.y, unit: "pixels" }
            };
        }
    } catch (err) {
        return {
            success: false,
            reason: `Coordinate strategy error: ${err instanceof Error ? err.message : String(err)}`
        };
    }
}

const TAP_TIMEOUT_MS = 25000;
const MIN_STRATEGY_BUDGET_MS = 500;

/** One React commit plus layout. Long enough for a just-navigated screen to paint. */
const EMPTY_SCREEN_SETTLE_MS = 400;

/**
 * True when both element strategies ran cleanly and between them saw *nothing* —
 * zero pressables and zero accessibility elements.
 *
 * That is not "the element isn't here", it is "the screen isn't here". A mounted
 * RN screen always has something in at least one of the two trees, so this
 * signature means the read landed in the gap right after a navigation or reload,
 * before the new screen committed. It matters because OCR runs next and OCR does
 * not fail quietly: it returns a confident closest-match for whatever text is
 * painted, which is how `tap({text})` right after a reload taps the wrong thing
 * and then succeeds unchanged on a manual retry.
 *
 * Both must have *run* — a strategy that timed out or was skipped proves nothing.
 */
export function screenLooksUnmounted(evidence: EvidenceSink | undefined): boolean {
    if (!evidence) return false;
    return (
        evidence.fiber.ran &&
        evidence.fiber.pressables.length === 0 &&
        evidence.accessibility.ran &&
        evidence.accessibility.elements.length === 0
    );
}
/**
 * Ceiling for the pre-dispatch overlay check. It shares the tap's deadline with the
 * strategies that follow, so it must not be able to spend the whole budget on a fiber
 * read — a screen big enough to make this slow is exactly when the tap still needs time.
 */
const OVERLAY_GUARD_BUDGET_MS = 3000;
// Per-strategy budget. OCR cap on Android is bumped via maxStrategyMs() because
// the ADB screencap+pull leg has ~2s variance on real devices; iOS stays at 5s
// where xcrun simctl screenshot is consistent.
// Heavy strategies (fiber on deep trees with multi-depth retries, axe accessibility
// dumps on dense iOS screens) need more headroom — previous caps produced spurious
// timeouts that the agent read as "element missing" when the strategy simply didn't
// get to finish. The overall TAP_TIMEOUT_MS budget still bounds the worst case.
// Coordinate looks "light" (one tap subprocess) but on iOS it pairs an axe/idb
// invocation with a CDP getDevicePixelRatio + best-effort fiber inspection;
// the 3000ms cap surfaced as spurious "coordinate timed out" failures while
// 20+ seconds of the overall budget were still unused. Align with the other
// strategies — the global TAP_TIMEOUT_MS still bounds the worst case.
const MAX_STRATEGY_MS: Record<string, number> = {
    fiber: 8000,
    accessibility: 6000,
    ocr: 6000,
    coordinate: 8000
};

function maxStrategyMs(strategy: string, platform: "ios" | "android"): number {
    if (strategy === "ocr" && platform === "android") return 9000;
    return MAX_STRATEGY_MS[strategy] ?? 5000;
}

// Matches only the outer withTimeout wrapper message for a tap strategy.
// Nested sub-operation errors inside a strategy (e.g. "CDP getProperties timed out after 150ms")
// must NOT be classified as a tap-level timeout.
const STRATEGY_TIMEOUT_RE = /^(fiber|accessibility|ocr|coordinate) timed out after \d+ms$/;

export function isTapTimeout(attempted: readonly { reason: string; strategy?: string; outcome?: TapAttemptOutcome }[]): boolean {
    return attempted.some(
        (a) => a.outcome === "timeout" || a.outcome === "skipped" || STRATEGY_TIMEOUT_RE.test(a.reason) || a.reason.startsWith("Skipped —")
    );
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            (val) => {
                clearTimeout(timer);
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

/**
 * Like withTimeout, but creates an AbortController whose signal is handed to
 * the inner factory. On timeout the signal aborts so subprocess work
 * (uiautomator dump, OCR fetch, screencap) can be killed instead of running
 * past the strategy cap and bleeding into total tap duration.
 */
function withCancelableTimeout<T>(
    make: (signal: AbortSignal) => Promise<T>,
    ms: number,
    label: string
): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return make(ctrl.signal).then(
        (val) => { clearTimeout(timer); return val; },
        (err) => {
            clearTimeout(timer);
            if (ctrl.signal.aborted) throw new Error(`${label} timed out after ${ms}ms`);
            throw err;
        }
    );
}

/**
 * Compute marker coordinates in screenshot-pixel space (what the returned PNG uses).
 * Unit rules by strategy, assuming screenshotScale = downscale factor:
 *   coordinate  : input is already screenshot pixels → pass through
 *   ocr         : match.tapCenter is image-pixel (= screenshot-pixel) → pass through
 *   iOS points  : point * DPR / screenshotScale
 *   android dp  : dp * densityScale / screenshotScale
 *   android devicePx : devicePx / screenshotScale
 */
function computeMarkerPx(args: {
    strategy: string;
    input?: { x: number; y: number };
    convertedTo?: { x: number; y: number; unit: string };
    platform: "ios" | "android";
    screenshotScale: number;
    devicePixelRatio?: number;
    androidDensityScale?: number;
}): { x: number; y: number } | undefined {
    const { strategy, input, convertedTo, platform, screenshotScale, devicePixelRatio, androidDensityScale } = args;
    const scale = screenshotScale || 1;

    if (strategy === "coordinate" || strategy === "native-coordinate") {
        return input ? { x: input.x, y: input.y } : undefined;
    }
    if (!convertedTo) return undefined;
    if (strategy === "ocr") {
        return { x: Math.round(convertedTo.x), y: Math.round(convertedTo.y) };
    }
    if (platform === "ios") {
        // fiber/accessibility on iOS return points
        const dpr = devicePixelRatio || 3;
        return {
            x: Math.round((convertedTo.x * dpr) / scale),
            y: Math.round((convertedTo.y * dpr) / scale)
        };
    }
    // Android
    if (strategy === "fiber+native" && androidDensityScale) {
        // Fabric fiber returns dp; fiber+native path scales to device pixels before tap
        return {
            x: Math.round((convertedTo.x * androidDensityScale) / scale),
            y: Math.round((convertedTo.y * androidDensityScale) / scale)
        };
    }
    // accessibility android: convertedTo is device pixels
    return {
        x: Math.round(convertedTo.x / scale),
        y: Math.round(convertedTo.y / scale)
    };
}


// --- Failure artifact capture ---

interface ArtifactCaptureContext {
    query: TapQuery;
    outcome: ArtifactOutcome;
    errorMessage?: string;
    errorCategory?: string;
    attempted: TapAttempt[];
    platform: "ios" | "android";
    iosDriver?: string;
    deviceName?: string;
    screenshotMeta?: { width: number; height: number };
    screenshotBuffer?: Buffer | null;
    afterWithMarker?: Buffer | null;
    chosenTapPoint?: { x: number; y: number } | null;
    verification?: TapVerification;
    fiberMatches?: TapResult["matches"];
    evidence?: EvidenceSink;
    /** `screen_changed:*` when the screen moved under the agent. See screenStaleness.ts. */
    staleTag?: string;
}

// D2 (Step 6): in-memory ring buffer of recent coord-strategy artifact keys
// `${round(x/20)}:${round(y/20)}`. Entries expire after 60s. The first
// failed coord tap at a grid cell uploads its artifact; retries within the
// window get suppressed.
const recentCoordArtifacts = new Map<string, number>();
const COORD_DEDUP_WINDOW_MS = 60_000;
const COORD_DEDUP_BUCKET = 20;

function shouldDedupArtifact(ctx: ArtifactCaptureContext): boolean {
    // Only applies to coordinate-strategy artifacts where we have x,y coords.
    const winningStrat = ctx.attempted.find(a => a.reason === "success")?.strategy
        ?? ctx.attempted[ctx.attempted.length - 1]?.strategy;
    if (winningStrat !== "coordinate") return false;
    const x = ctx.chosenTapPoint?.x ?? (ctx.query as { x?: number }).x;
    const y = ctx.chosenTapPoint?.y ?? (ctx.query as { y?: number }).y;
    if (typeof x !== "number" || typeof y !== "number") return false;
    const key = `${Math.round(x / COORD_DEDUP_BUCKET)}:${Math.round(y / COORD_DEDUP_BUCKET)}`;
    const now = Date.now();
    // Sweep stale entries opportunistically — keeps the map from growing.
    for (const [k, ts] of recentCoordArtifacts) {
        if (now - ts > COORD_DEDUP_WINDOW_MS) recentCoordArtifacts.delete(k);
    }
    const last = recentCoordArtifacts.get(key);
    if (last !== undefined && (now - last) < COORD_DEDUP_WINDOW_MS) return true;
    recentCoordArtifacts.set(key, now);
    return false;
}

/** Test-only: drop the dedup state so a fresh tap always uploads. */
export function resetCoordArtifactDedup(): void {
    recentCoordArtifacts.clear();
}

/**
 * Turn an unmeaningful coordinate tap into an explanation.
 *
 * Coordinate spaces used to be the hard part here, and the old approach — recovering a
 * scale by dividing the caller's input by the executed tap point, then multiplying the
 * raw screen state by it — was wrong in a way that mattered. That ratio carries no inset
 * term, but the caller's coordinate comes from a space where `topInset` has been applied,
 * so on Android and inside iOS modal presentations the probe landed roughly
 * `topInset x factor` off. An offset probe can hit-test a neighbouring element, and
 * because `explainCoordinateMiss` checks reachable pressables before blocked ones, the
 * usual result was a confident "the coordinates were correct, check your onPress handler"
 * about an element that was in fact covered.
 *
 * Now that every tool shares one space, there is nothing to recover: normalise the state
 * the same way the layout tools do and hit-test the caller's own coordinate against it.
 */
async function diagnoseCoordinateMiss(args: {
    point: { x: number; y: number };
    pointUnit: string;
    inputPoint: { x: number; y: number };
    deviceName?: string;
}): Promise<CoordinateMissDiagnosis | undefined> {
    try {
        const { getScreenState } = await import("../core/screenState.js");
        const { explainCoordinateMiss } = await import("./coordinateMiss.js");
        const { screenStateToScreenSpace, screenStateToDeliveredPx } = await import("../core/screenSpace.js");
        const { resolveScreenSpaceMetrics } = await import("../core/screenSpaceDevice.js");
        const { getConnectedAppByDevice, getFirstConnectedApp } = await import("../core/index.js");

        const ss = await getScreenState({ device: args.deviceName });
        if (!ss.success || !ss.screenState) return undefined;

        const app = (args.deviceName ? getConnectedAppByDevice(args.deviceName) : null) ?? getFirstConnectedApp();
        const metrics = await resolveScreenSpaceMetrics({
            platform: app?.platform ?? "ios",
            udid: app?.simulatorUdid,
            deviceId: app?.adbSerial
        });

        const normalised = screenStateToDeliveredPx(
            screenStateToScreenSpace(ss.screenState, metrics),
            metrics
        );

        // State and probe are both in delivered pixels now, so the reported coordinates
        // are already the caller's space — no mapping back.
        return explainCoordinateMiss(args.inputPoint, normalised) ?? undefined;
    } catch {
        // Diagnosis is best-effort — never let it turn a successful tap into an error.
        return undefined;
    }
}

/**
 * What fiber saw on screen, as stable element identities.
 *
 * `bounds` is excluded on purpose: a scroll moves every element without any of
 * them leaving, and identity that shifts with position would report ordinary
 * scrolling as the screen having been replaced.
 */
function tapScreenElements(evidence: EvidenceSink | undefined): string[] {
    return (evidence?.fiber.pressables ?? []).map(
        p => p.testID || [p.componentName, p.label].filter(Boolean).join("|") || "?"
    );
}

/** Records the screen fiber just enumerated, as the baseline for the next miss. */
function recordTapScreen(deviceName: string | undefined, evidence: EvidenceSink | undefined): void {
    const elements = tapScreenElements(evidence);
    if (elements.length > 0) recordScreen(deviceName, { elements, focused: false });
}

/**
 * Whether a tap that found nothing found nothing because the screen moved.
 *
 * See core/screenStaleness.ts — a person driving the simulator in parallel
 * produces exactly the same "No element found" as a wrong predicate does, and
 * only one of the two is a defect in tap.
 */
function diagnoseTapStaleness(
    deviceName: string | undefined,
    evidence: EvidenceSink | undefined
): StalenessVerdict | undefined {
    const elements = tapScreenElements(evidence);
    if (elements.length === 0) return undefined;
    const verdict = diagnoseStaleness(deviceName, { elements, focused: false });
    return verdict.kind === "genuine_miss" ? undefined : verdict;
}

async function captureTapArtifact(ctx: ArtifactCaptureContext): Promise<CaptureSignals | undefined> {
    try {
        const { getServerVersion, categorizeError } = await import("../core/telemetry.js");
        const strategyChain = [
            ctx.staleTag,
            ...ctx.attempted.map(a => `${a.strategy}:${a.reason.slice(0, 40)}`)
        ].filter(Boolean).join("|");

        // Resolve error category up-front so we can short-circuit driver-missing failures.
        // These aren't tap-tool bugs — they're host setup problems (no idb/axe/adb on PATH).
        // Skipping the artifact upload saves R2 storage and stops these from polluting the
        // failure dashboard, which is the signal we use to triage genuine tap regressions.
        const errorCategory = ctx.errorCategory
            ?? categorizeError(ctx.errorMessage ?? "", strategyChain);
        if (errorCategory === "driver_missing") {
            return undefined;
        }

        // D1 (Step 6): no-metro unmeaningful taps have no diagnostic signal
        // beyond a screenshot diff that's already below threshold by definition.
        // ~50% of recent failure-artifact rows were these — they crowd out real
        // failures in the dashboard. Telemetry row still flows; just no R2 bundle.
        const noMetro = ctx.evidence ? !ctx.evidence.fiber.metroConnected : connectedApps.size === 0;
        if (ctx.outcome === "unmeaningful" && noMetro) {
            return undefined;
        }

        // D2 (Step 6): retry deduplication — coord-strategy taps at the same
        // grid cell within 60s upload the same near-identical artifact. The
        // first capture is enough; subsequent ones are noise.
        if (shouldDedupArtifact(ctx)) {
            return undefined;
        }

        const result = await captureFailureArtifact({
            outcome: ctx.outcome,
            predicate: ctx.query as Record<string, unknown>,
            errorMessage: ctx.errorMessage,
            errorCategory,
            strategyChain,
            sessionId: "",
            version: getServerVersion(),
            changeRate: ctx.verification?.changeRate,
            meaningful: ctx.verification?.meaningful,
            senses: ctx.evidence
                ? {
                    ocr: {
                        ran: ctx.evidence.ocr.ran,
                        durationMs: ctx.evidence.ocr.durationMs,
                        detections: ctx.evidence.ocr.detections,
                        closestMatch: ctx.evidence.ocr.closestMatch
                    },
                    fiber: {
                        ran: ctx.evidence.fiber.ran,
                        durationMs: ctx.evidence.fiber.durationMs,
                        metroConnected: ctx.evidence.fiber.metroConnected,
                        pressables: ctx.evidence.fiber.pressables.map(p => ({
                            label: p.label,
                            testID: p.testID,
                            componentName: p.componentName,
                            bounds: p.bounds
                                ? [p.bounds.x, p.bounds.y, p.bounds.width, p.bounds.height]
                                : undefined
                        }))
                    },
                    accessibility: {
                        ran: ctx.evidence.accessibility.ran,
                        durationMs: ctx.evidence.accessibility.durationMs,
                        elements: ctx.evidence.accessibility.elements.map(el => ({
                            label: el.label,
                            testID: el.testID,
                            frame: el.frame
                                ? [el.frame.x, el.frame.y, el.frame.width, el.frame.height]
                                : undefined
                        }))
                    }
                }
                : {
                    ocr: { ran: false, durationMs: 0, detections: [], closestMatch: null },
                    fiber: {
                        ran: ctx.attempted.some(a => a.strategy === "fiber"),
                        durationMs: 0,
                        metroConnected: connectedApps.size > 0,
                        pressables: (ctx.fiberMatches || []).slice(0, 10).map(m => ({
                            label: m.text || undefined,
                            testID: m.testID || undefined,
                            componentName: m.component
                        }))
                    },
                    accessibility: {
                        ran: ctx.attempted.some(a => a.strategy === "accessibility"),
                        durationMs: 0,
                        elements: []
                    }
                },
            chosenTapPoint: ctx.chosenTapPoint ?? null,
            chosenElement: null,
            screenshots: {
                before: ctx.screenshotBuffer ?? null,
                afterWithMarker: ctx.afterWithMarker ?? null
            },
            deviceMeta: {
                platform: ctx.platform,
                driver: ctx.iosDriver,
                screenSize: { w: ctx.screenshotMeta?.width || 0, h: ctx.screenshotMeta?.height || 0 }
            }
        });
        return result.signals;
    } catch {
        return undefined;
    }
}

function attachArtifactSignals(result: TapResult, signals: CaptureSignals | undefined): TapResult {
    if (!signals) return result;
    if (signals.artifactKey) result.artifactKey = signals.artifactKey;
    if (signals.ocrClosestMatch) result.ocrClosestMatch = signals.ocrClosestMatch;
    if (signals.fiberPressableCount) result.fiberPressableCount = signals.fiberPressableCount;
    if (signals.accessibilityMatchCount) result.accessibilityMatchCount = signals.accessibilityMatchCount;
    if (signals.appRoute) result.appRoute = signals.appRoute;
    // Append agent-facing hints to error message
    if (result.error) {
        if (signals.ocrClosestMatch) {
            result.error = `${result.error}\nClosest OCR match: ${signals.ocrClosestMatch}`;
        }
        if (signals.nearbyPressables.length > 0) {
            const labels = signals.nearbyPressables
                .map(p => p.testID || p.label)
                .filter(Boolean)
                .slice(0, 3)
                .join(", ");
            if (labels) result.error = `${result.error}\nNearby pressables: ${labels}`;
        }
    }
    return result;
}

// --- Orchestrator ---

export async function tap(options: TapOptions): Promise<TapResult> {
    const query = buildQuery(options);
    const strategy = options.strategy || "auto";
    const index = options.index;
    const maxTraversalDepth = options.maxTraversalDepth;
    const deadline = Date.now() + TAP_TIMEOUT_MS;
    const remainingMs = () => Math.max(0, deadline - Date.now());

    // Validate inputs
    const hasSearchParam = query.text || query.testID || query.component;
    const hasCoordinates = query.x !== undefined || query.y !== undefined;

    if (!hasSearchParam && !hasCoordinates) {
        return {
            success: false,
            query,
            error: "Must provide at least one of: text, testID, component, or x/y coordinates"
        };
    }

    if (hasCoordinates && (query.x === undefined || query.y === undefined)) {
        return {
            success: false,
            query,
            error: "Both x and y coordinates must be provided"
        };
    }

    // Native mode: bypass React Native connection, tap directly via ADB/simctl
    if (options.native && hasCoordinates) {
        const nativeResolved = await resolveDeviceTarget(options.device);
        if (!nativeResolved.ok) {
            return {
                success: false,
                query,
                error: formatResolverError(nativeResolved.error)
            };
        }
        const platform: "ios" | "android" = nativeResolved.target.platform;
        const nativeUdid: string | undefined = nativeResolved.target.iosUdid;
        const nativeSerial: string | undefined = nativeResolved.target.androidSerial;

        const nativeShouldScreenshot = options.screenshot !== false;
        // Decoupled (I5, 2026-05-16): verify runs even when image bytes aren't returned.
        const nativeShouldVerify = options.verify !== false;
        let nativeBeforeBuffer: Buffer | null = null;
        let nativeScreenshotMeta: { originalWidth: number; originalHeight: number; scaleFactor: number } | undefined;
        if (nativeShouldVerify) {
            const before = await captureScreenshot(platform, nativeUdid, nativeSerial);
            nativeBeforeBuffer = before?.buffer || null;
            if (before) {
                nativeScreenshotMeta = {
                    originalWidth: before.width,
                    originalHeight: before.height,
                    scaleFactor: before.scaleFactor
                };
            }
        }

        // If no screenshot was taken for verification, take one just for scaleFactor
        if (!nativeScreenshotMeta) {
            const ref = await captureScreenshot(platform, nativeUdid, nativeSerial);
            if (ref) {
                nativeScreenshotMeta = {
                    originalWidth: ref.width,
                    originalHeight: ref.height,
                    scaleFactor: ref.scaleFactor
                };
                // Also use it for verification if buffer is needed
                if (!nativeBeforeBuffer) {
                    nativeBeforeBuffer = ref.buffer;
                }
            }
        }

        let result: StrategyResult;
        try {
            result = await withTimeout(
                tryCoordinateStrategy(query.x!, query.y!, platform, nativeScreenshotMeta, nativeUdid, nativeSerial, options.duration),
                remainingMs(),
                "native-coordinate"
            );
        } catch (err) {
            return formatTapFailure({
                query,
                attempted: [
                    {
                        strategy: "native-coordinate",
                        reason: err instanceof Error ? err.message : String(err)
                    }
                ],
                suggestion: `Tap timed out. Take a screenshot (${platform === "ios" ? "ios_screenshot" : "android_screenshot"}) and retry with coordinates.`
            });
        }
        if (result.success) {
            let screenshot: TapScreenshot | undefined;
            let verification: TapVerification | undefined;
            const nativeMarker = computeMarkerPx({
                strategy: "native-coordinate",
                input: { x: query.x!, y: query.y! },
                platform,
                screenshotScale: nativeScreenshotMeta?.scaleFactor || 1
            });
            if (options.burst && nativeShouldVerify && nativeBeforeBuffer) {
                ({ screenshot, verification } = await burstCaptureAndVerify({
                    platform,
                    beforeBuffer: nativeBeforeBuffer,
                    udid: nativeUdid,
                    deviceId: nativeSerial,
                    beforeScaleFactor: nativeScreenshotMeta?.scaleFactor,
                    markerPx: nativeMarker
                }));
                if (!nativeShouldScreenshot) screenshot = undefined;
            } else {
                ({ screenshot, verification } = await verifyAndCapture({
                    platform,
                    shouldVerify: nativeShouldVerify,
                    shouldScreenshot: nativeShouldScreenshot,
                    beforeBuffer: nativeBeforeBuffer,
                    udid: nativeUdid,
                    deviceId: nativeSerial,
                    beforeScaleFactor: nativeScreenshotMeta?.scaleFactor,
                    markerPx: nativeMarker
                }));
            }
            const nativeSuccess = formatTapSuccess({
                method: "native-coordinate",
                query,
                pressed: result.pressed,
                convertedTo: result.convertedTo,
                platform,
                screenshot,
                verification
            });
            // hasLongPress stays undefined here: a coordinate tap inspects nothing.
            const nativeLongPress = buildLongPressReport({ durationMs: options.duration });
            if (nativeLongPress) nativeSuccess.longPress = nativeLongPress;
            return nativeSuccess;
        }
        return formatTapFailure({
            query,
            attempted: [{ strategy: "native-coordinate", reason: result.reason }],
            suggestion: `Take a screenshot (${platform === "ios" ? "ios_screenshot" : "android_screenshot"}) to verify coordinates.`
        });
    }

    // Resolve device target via the unified resolver. Replaces the prior chain
    // of (udid → connectedApp → findSimulatorByName) lookups and the standalone
    // "no platform → probe OS for devices" branch. Returns a structured error
    // when ambiguous; surface that to the caller so they can disambiguate.
    const resolved = await resolveDeviceTarget(options.device);
    if (!resolved.ok) {
        return {
            success: false,
            query,
            error: formatResolverError(resolved.error)
        };
    }
    const deviceNote = resolved.note;
    const platform: "ios" | "android" = resolved.target.platform;
    let targetUdid: string | undefined = resolved.target.iosUdid;
    // Android's counterpart to targetUdid. Every adb call below takes it; without
    // it adb falls back to its own default device, which on a multi-emulator
    // setup is not the one the caller asked for.
    const targetSerial: string | undefined = resolved.target.androidSerial;

    // Pick the connected app to bias strategy selection. Prefer the registry
    // entry whose identifier matches the resolved target; fall back to a
    // device-name match (handy when registry entries lack identifiers yet);
    // last resort is the first connected app on the matching platform.
    const allApps = Array.from(connectedApps.values());
    let hasMetro = allApps.length > 0;
    let app: ConnectedApp | undefined;
    if (resolved.target.iosUdid) {
        app = allApps.find((a) => a.platform === "ios" && a.simulatorUdid === resolved.target.iosUdid);
    } else if (resolved.target.androidSerial) {
        app = allApps.find((a) => a.platform === "android" && a.adbSerial === resolved.target.androidSerial);
    }
    if (!app && options.device) {
        try {
            app = getConnectedAppByDevice(options.device) ?? undefined;
        } catch {
            // getConnectedAppByDevice throws on ambiguous matches; the resolver
            // would have already returned that error, so reaching here means
            // the resolved target's identifier just doesn't appear in the
            // registry yet — fall through to the platform-first pick below.
        }
    }
    if (!app) {
        app = allApps.find((a) => a.platform === platform) ?? allApps[0];
    }

    // Try to auto-connect to Metro (for fiber strategy), but don't fail if it doesn't work.
    if (!hasMetro) {
        try {
            await withTimeout(
                (async () => {
                    clearReconnectionSuppression();
                    const openPorts = await scanMetroPorts();
                    for (const port of openPorts) {
                        const devices = await fetchDevices(port);
                        const mainDevice = selectMainDevice(devices);
                        if (mainDevice) {
                            await connectToDevice(mainDevice, port);
                            break;
                        }
                    }
                })(),
                Math.min(remainingMs(), 3000),
                "auto-connect"
            );
            const apps = Array.from(connectedApps.values());
            hasMetro = apps.length > 0;
            app = apps.find((a) => a.platform === platform) ?? apps[0];
            if (platform === "ios" && !targetUdid) {
                targetUdid = app?.simulatorUdid ?? targetUdid;
            }
        } catch {
            // Auto-connect failed — Metro-dependent strategies will be skipped
        }
    }

    // The response's `device` label must reflect the RESOLVED target, not the
    // registry-app fallback. When the registry lookup couldn't find a matching
    // app (e.g. simulatorUdid hadn't been backfilled yet), `app` lands on the
    // first iOS entry — which on a multi-sim setup is the WRONG device. The
    // resolver already knows the right deviceName; trust it. Bug #5 (2026-05-20).
    const deviceName = resolved.target.deviceName || app?.deviceInfo?.deviceName;

    // Determine strategies
    const strategies = getAvailableStrategies(query, strategy);
    const attempted: TapAttempt[] = [];
    const evidence = makeEmptyEvidenceSink();

    // Early UI driver check for iOS — fail fast instead of falling through every strategy
    const UI_DRIVER_REQUIRED_STRATEGIES = ["accessibility", "ocr", "coordinate"];
    let uiDriverMissing = false;
    if (platform === "ios") {
        uiDriverMissing = !(await isUiDriverAvailable());
    }

    // Filter strategies by available capabilities
    const filteredStrategies = strategies.filter((strat) => {
        if (strat === "fiber" && !hasMetro) {
            attempted.push({
                strategy: "fiber",
                reason: "Skipped — no Metro connection (required for fiber)",
                outcome: "skipped"
            });
            return false;
        }
        if (uiDriverMissing && UI_DRIVER_REQUIRED_STRATEGIES.includes(strat)) {
            attempted.push({
                strategy: strat,
                reason: "Skipped — iOS UI driver is not installed (required for iOS tap/accessibility/OCR)",
                outcome: "skipped"
            });
            return false;
        }
        return true;
    });

    if (filteredStrategies.length === 0) {
        if (uiDriverMissing) {
            notifyDriverMissing("ios");
        }
        const errorMessage = uiDriverMissing
            ? `Cannot tap on iOS Simulator — ${getUiDriverInstallHint()}\n\nThe iOS UI driver is required for tapping, swiping, text input, and accessibility queries on iOS Simulators.\n\nAfter installing, retry the tap.`
            : "All strategies require Metro connection, which is unavailable.\n\nTo fix:\n1. Make sure your React Native app is running\n2. Run scan_metro to connect\n3. Or use tap(x, y, native=true) for coordinate-based taps";
        return {
            success: false,
            query,
            attempted,
            error: errorMessage
        };
    }

    // Refuse before dispatch when the target is under an overlay. Every strategy resolves
    // to a coordinate tap, so the OS would deliver the touch to the overlay — firing it
    // would press the wrong element and mutate state the caller never asked to change.
    //
    // Bounded, and failure-open by construction: the guard costs one fiber read, and if
    // that read is slow, errors, or cannot reach a verdict, the tap proceeds exactly as it
    // did before. Blocking a legitimate tap because a diagnostic timed out would be a far
    // worse regression than the mis-delivery this prevents — tap is the tool everything
    // else is built on.
    // Set when the tap is dispatched onto an overlay control that shadows a covered
    // element; attached to the successful result so the caller learns what actually
    // received the touch.
    let shadowWarning: string | undefined;
    if (hasMetro) {
        const guardBudget = Math.min(remainingMs(), OVERLAY_GUARD_BUDGET_MS);
        if (guardBudget >= MIN_STRATEGY_BUDGET_MS) {
            let blockedBy: Awaited<ReturnType<typeof import("./overlayGuard.js")["checkOverlayBlocking"]>> = null;
            try {
                const { checkOverlayBlocking } = await import("./overlayGuard.js");
                blockedBy = await withTimeout(
                    checkOverlayBlocking({
                        query,
                        platform,
                        udid: targetUdid,
                        deviceId: resolved.target.androidSerial,
                        deviceName
                    }),
                    guardBudget,
                    "overlay-guard"
                );
            } catch {
                blockedBy = null;
            }
            if (blockedBy?.kind === "blocked") {
                // Recorded as an attempt so the refusal is distinguishable in telemetry
                // (_errorContext) from a tap that tried and failed. Without it every
                // declined tap looks like a tap-tool regression on the failure dashboard.
                attempted.push({
                    strategy: "overlay-guard",
                    reason: `refused — target covered by ${blockedBy.overlay}`,
                    outcome: "skipped"
                });
                return {
                    success: false,
                    query,
                    attempted,
                    device: deviceName,
                    platform,
                    error:
                        `Refused: ${blockedBy.element} is covered by ${blockedBy.overlay}. ` +
                        `A tap here would be delivered to the overlay, not to the target, ` +
                        `so it was not dispatched.`,
                    suggestion:
                        `Dismiss or close the overlay first, then retry. ` +
                        `get_screen_state lists the overlay's own controls, and everything behind it under "🚫 Blocked by overlay". ` +
                        `To tap the overlay itself, use coordinates from its own group.`
                };
            }
            if (blockedBy?.kind === "shadowed") {
                // Dispatch, but name the element that will actually receive the touch.
                // Staying silent here is the reported bug in miniature.
                shadowWarning =
                    `This coordinate is occupied by ${blockedBy.hit}, part of ${blockedBy.overlay} — ` +
                    `that is what received the tap. ${blockedBy.covered} sits underneath it and ` +
                    `cannot be tapped until the overlay closes.`;
            }
        }
    }

    // Determine screenshot and verification behavior.
    // Decoupled (I5, 2026-05-16): verify can run without returning image bytes —
    // capture cost is paid either way; bandwidth cost is what `screenshot` toggles.
    const shouldScreenshot = options.screenshot !== false;
    const canVerify = options.verify !== false;

    // Capture "before" screenshot. Always attempted (independent of canVerify)
    // so failure artifacts always carry a before.png — the diagnostic value of
    // the before frame doesn't depend on whether we run the post-tap diff.
    let beforeBuffer: Buffer | null = null;
    let beforeScaleFactor: number | undefined;
    // Pixel dimensions of the frame we just captured. getDevicePixelRatio would
    // otherwise shell out for a screenshot of its own to learn exactly this.
    let beforeDims: { width: number; height: number } | undefined;
    {
        const before = await captureScreenshot(platform, targetUdid, targetSerial);
        beforeBuffer = before?.buffer || null;
        beforeScaleFactor = before?.scaleFactor;
        if (before && before.width > 0 && before.height > 0) {
            beforeDims = { width: before.width, height: before.height };
        }
    }

    // OCR runs lazily when the loop reaches it (see the `case "ocr"` branch).
    // A concurrent pre-warm probe used to fire here to shave ~5s off OCR-win
    // rows, but it dispatched a paid Google Vision request at t=0 on every
    // text-predicate tap — and since cloud OCR (~200ms) finishes well before
    // the higher-priority strategy that usually wins, the post-win abort came
    // too late to cancel the billed request. OCR wins only ~1.9% of taps, so
    // the pre-warm paid for cloud Vision on ~42% of eligible taps to help a
    // tiny minority. Removed 2026-06-02; the timeout-recovery path below still
    // salvages the perfect-match-past-cap case.
    // Execute strategies in order with per-strategy caps and overall budget
    // `strat` is reassigned when the empty-screen replay below resolves the tap
    // through a different strategy — every downstream use (marker geometry,
    // reported method) must name the strategy that actually pressed.
    let emptyScreenReplayed = false;
    for (let strat of filteredStrategies) {
        const remaining = remainingMs();
        if (remaining < MIN_STRATEGY_BUDGET_MS) {
            attempted.push({
                strategy: strat,
                reason: `Skipped — only ${remaining}ms remaining (budget ${TAP_TIMEOUT_MS}ms)`,
                outcome: "skipped"
            });
            continue;
        }

        const cap = maxStrategyMs(strat, platform);
        const budget = Math.min(cap, remaining);

        let result: StrategyResult;

        try {
            switch (strat) {
                case "fiber":
                    // Fiber is JS-only against a CDP target — no subprocess to cancel,
                    // so the cheaper non-cancellable wrapper is fine.
                    result = await withTimeout(tryFiberStrategy(query, index, maxTraversalDepth, evidence, deviceName, options.duration !== undefined), budget, `fiber`);
                    break;
                case "accessibility":
                    result = await withCancelableTimeout(
                        (signal) => tryAccessibilityStrategy(query, index, platform, targetUdid, evidence, signal, targetSerial, options.duration),
                        budget,
                        `accessibility`
                    );
                    break;
                case "ocr": {
                    // Before letting OCR answer for a screen that had no elements at
                    // all, give the tree one settle and ask again. OCR cannot tell a
                    // half-painted screen from a settled one, so without this the
                    // caller gets a confident match against whatever was mid-paint.
                    if (!emptyScreenReplayed && screenLooksUnmounted(evidence)) {
                        emptyScreenReplayed = true;
                        attempted.push({
                            strategy: "settle",
                            reason: `Screen had zero pressables and zero accessibility elements — not settled yet. Waited ${EMPTY_SCREEN_SETTLE_MS}ms and re-read before falling back to OCR.`,
                            outcome: "not-found"
                        });
                        await new Promise((r) => setTimeout(r, EMPTY_SCREEN_SETTLE_MS));

                        let replayed: StrategyResult | null = null;
                        for (const replayStrat of ["fiber", "accessibility"] as const) {
                            if (!filteredStrategies.includes(replayStrat)) continue;
                            const replayBudget = Math.min(maxStrategyMs(replayStrat, platform), remainingMs());
                            if (replayBudget < MIN_STRATEGY_BUDGET_MS) continue;
                            let replayResult: StrategyResult;
                            try {
                                replayResult = replayStrat === "fiber"
                                    ? await withTimeout(tryFiberStrategy(query, index, maxTraversalDepth, evidence, deviceName, options.duration !== undefined), replayBudget, `fiber`)
                                    : await withCancelableTimeout(
                                        (signal) => tryAccessibilityStrategy(query, index, platform, targetUdid, evidence, signal, targetSerial, options.duration),
                                        replayBudget,
                                        `accessibility`
                                    );
                            } catch {
                                // A replay that times out or throws is no worse than not
                                // having replayed — fall through to OCR as before.
                                continue;
                            }
                            if (replayResult.success) {
                                strat = replayStrat;
                                replayed = replayResult;
                                break;
                            }
                        }
                        if (replayed) {
                            result = replayed;
                            break;
                        }
                    }
                    result = await withCancelableTimeout(
                        (signal) => tryOcrStrategy(query, platform, targetUdid, evidence, signal, targetSerial, options.duration),
                        budget,
                        `ocr`
                    );
                    break;
                }
                case "coordinate":
                    // Prefer `beforeScaleFactor` (captured against `targetUdid` this turn)
                    // over `app.lastScreenshot.scaleFactor` (stale and may belong to a
                    // different device on a multi-sim setup). Bug #5 (2026-05-20).
                    result = await withTimeout(
                        tryCoordinateStrategy(
                            query.x!,
                            query.y!,
                            platform,
                            beforeScaleFactor != null
                                ? {
                                    originalWidth: beforeDims?.width ?? 0,
                                    originalHeight: beforeDims?.height ?? 0,
                                    scaleFactor: beforeScaleFactor
                                }
                                : app?.lastScreenshot,
                            targetUdid,
                            targetSerial,
                            options.duration
                        ),
                        budget,
                        `coordinate`
                    );
                    break;
                default:
                    result = { success: false, reason: `Unknown strategy: ${strat}` };
            }
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            // Classify the throw: a strategy-level timeout means "result UNKNOWN"
            // (the strategy didn't finish), distinct from "ran clean and found
            // nothing". Agents must not infer absence from timeouts. The
            // `outcome` field carries that distinction; `reason` stays the raw
            // message so existing log-matchers / classifiers keep working.
            const outcome: TapAttemptOutcome = STRATEGY_TIMEOUT_RE.test(reason) ? "timeout" : "error";
            attempted.push({ strategy: strat, reason, outcome });
            continue;
        }

        if (result.success) {
            let screenshot: TapScreenshot | undefined;
            let verification: TapVerification | undefined;
            let afterWithMarkerBuffer: Buffer | undefined;
            let dprForMarker: number | undefined;
            if (platform === "ios") {
                try {
                    const { getDevicePixelRatio } = await import("../core/ios.js");
                    dprForMarker = await getDevicePixelRatio(targetUdid, beforeDims);
                } catch { dprForMarker = 3; }
            }
            const strategyMarker = computeMarkerPx({
                strategy: strat,
                input: strat === "coordinate" ? { x: query.x!, y: query.y! } : undefined,
                convertedTo: result.convertedTo,
                platform,
                screenshotScale: beforeScaleFactor || app?.lastScreenshot?.scaleFactor || 1,
                devicePixelRatio: dprForMarker
            });
            if (options.burst && canVerify && beforeBuffer) {
                ({ screenshot, verification, afterWithMarkerBuffer } = await burstCaptureAndVerify({
                    platform,
                    beforeBuffer,
                    udid: targetUdid,
                    deviceId: targetSerial,
                    beforeScaleFactor,
                    markerPx: strategyMarker
                }));
                // Burst always produces a screenshot for diff visualization. Drop the
                // bytes when the caller didn't ask for them AND the tap was meaningful
                // — keeping the screenshot on unmeaningful taps saves the agent a
                // round-trip when it needs to diagnose. Frames remain in imageBuffer
                // either way (accessible via get_images(groupId=verification.burstGroupId)).
                if (!shouldScreenshot && verification?.meaningful !== false) screenshot = undefined;
            } else {
                ({ screenshot, verification, afterWithMarkerBuffer } = await verifyAndCapture({
                    platform,
                    shouldVerify: canVerify,
                    shouldScreenshot: true,
                    beforeBuffer,
                    udid: targetUdid,
                    deviceId: targetSerial,
                    beforeScaleFactor,
                    markerPx: strategyMarker
                }));
                // Mirror the burst-path gate: drop the screenshot only when the
                // caller didn't ask for it AND the tap was meaningful.
                if (!shouldScreenshot && verification?.meaningful !== false) screenshot = undefined;
            }
            if (screenshot && app) {
                app.lastScreenshot = {
                    originalWidth: screenshot.width,
                    originalHeight: screenshot.height,
                    scaleFactor: screenshot.scaleFactor
                };
            }
            const successResult = formatTapSuccess({
                method: strat,
                query,
                pressed: result.pressed,
                text: result.text,
                path: result.path,
                component: result.component,
                convertedTo: result.convertedTo,
                platform,
                device: deviceName,
                deviceNote,
                screenshot,
                verification
            });
            // `result.hasLongPress` is set only by the fiber strategy; for accessibility,
            // OCR and coordinate taps it is undefined, which the report renders as
            // "not knowable" rather than "no handler".
            const strategyLongPress = buildLongPressReport({
                durationMs: options.duration,
                hasLongPress: result.hasLongPress,
                element: result.pressed
            });
            if (strategyLongPress) successResult.longPress = strategyLongPress;
            const strategySwitch = await buildSwitchReport({
                before: result.switchValue,
                query,
                index: options.index,
                device: options.device,
                element: result.pressed
            });
            if (strategySwitch) successResult.switch = strategySwitch;
            // The guard already resolved what occupies this coordinate. Reporting it turns
            // "something responded" into "this element responded" for the one case where
            // the caller most likely meant something else.
            if (shadowWarning) {
                successResult.warning = successResult.warning
                    ? `${successResult.warning}\n${shadowWarning}`
                    : shadowWarning;
            }
            // Capture an artifact for "successful but unmeaningful" taps so we can
            // diagnose taps that landed wrong or hit non-responsive elements.
            // Uses the same `meaningful` flag the agent sees so dashboard outcomes
            // stay consistent with what the caller observed.
            if (verification && !verification.skipped && verification.meaningful === false) {
                // A coordinate tap that changed nothing is the one case where the
                // agent has no idea what went wrong — it estimated x/y from a
                // screenshot and got back "nothing happened". Screen state knows
                // what sits at that point and what an overlay blocks; spend the
                // ~200ms here (already the slow path) to turn a dead end into a
                // next step. Text/testID/component predicates don't need this:
                // their failure modes are already named in `attempted`.
                if (strat === "coordinate" && result.convertedTo) {
                    const diagnosis = await diagnoseCoordinateMiss({
                        point: { x: result.convertedTo.x, y: result.convertedTo.y },
                        pointUnit: result.convertedTo.unit,
                        inputPoint: { x: query.x!, y: query.y! },
                        deviceName
                    });
                    if (diagnosis) {
                        successResult.missDiagnosis = diagnosis;
                        if (successResult.verification) {
                            successResult.verification = {
                                ...successResult.verification,
                                explanation: `${successResult.verification.explanation} ${diagnosis.suggestion}`
                            };
                        }
                    }
                }
                const unmeaningfulSignals = await captureTapArtifact({
                    query,
                    outcome: "unmeaningful",
                    attempted: [...attempted, { strategy: strat, reason: "success" }],
                    platform,
                    iosDriver: platform === "ios" ? (process.env.IOS_DRIVER?.toLowerCase() || "axe") : undefined,
                    deviceName,
                    screenshotMeta: screenshot ? { width: screenshot.width, height: screenshot.height } : undefined,
                    screenshotBuffer: beforeBuffer,
                    afterWithMarker: afterWithMarkerBuffer ?? null,
                    chosenTapPoint: strategyMarker ? { x: strategyMarker.x, y: strategyMarker.y } : null,
                    verification,
                    evidence
                });
                attachArtifactSignals(successResult, unmeaningfulSignals);
            }
            // The tap resolved, so this is the last moment the screen is known
            // to have matched the agent's model of it — the baseline the next
            // miss is judged against.
            recordTapScreen(deviceName, evidence);
            return successResult;
        }

        // Classify the strategy's non-success result. The reason string carries
        // the diagnostic from the strategy; outcome lets agents branch on category
        // without parsing prose. "invisible" / "ambiguous" are pinned by substring
        // matches the fiber strategy emits via pressables.ts.
        const reasonStr = result.reason || "";
        let attemptOutcome: TapAttemptOutcome = "not-found";
        if (result.ambiguous) attemptOutcome = "ambiguous";
        else if (reasonStr.indexOf("but none are visible") !== -1) attemptOutcome = "invisible";
        else if (STRATEGY_TIMEOUT_RE.test(reasonStr)) attemptOutcome = "timeout";
        attempted.push({ strategy: strat, reason: reasonStr, outcome: attemptOutcome });

        // If fiber found an element with measured coordinates, do a native tap directly
        if (strat === "fiber" && result.convertedTo && result.pressed) {
            try {
                const coords = result.convertedTo;
                if (platform === "ios") {
                    // react-native-screens modal/sheet presentations cause measureInWindow to
                    // return y relative to the screen's content origin, not the window. If the
                    // measured y falls inside the safe-area band, shift it down by the inset.
                    const safeAreaTop = await getIOSSafeAreaTop(targetUdid);
                    const tapY = (safeAreaTop > 0 && coords.y < safeAreaTop) ? coords.y + safeAreaTop : coords.y;
                    await iosTap(coords.x, tapY, { udid: targetUdid, duration: options.duration });
                    coords.y = tapY;
                } else {
                    // Fabric returns dp — androidTap expects pixels
                    // Convert dp to pixels using device density
                    const { androidGetDensity } = await import("../core/android.js");
                    const densityResult = await androidGetDensity(targetSerial);
                    const densityScale = (densityResult.density || 420) / 160;
                    const pxX = Math.round(coords.x * densityScale);
                    const pxY = Math.round(coords.y * densityScale);
                    const fiberTap = await androidTap(pxX, pxY, targetSerial, options.duration);
                    if (!fiberTap.success) {
                        throw new Error(fiberTap.error || "adb tap failed");
                    }
                    // Report the actual tap coords (pixels) the caller can pass straight
                    // to coordinate tools / verification — not the raw dp from fiber.
                    // Matches every other Android coord report in the tool (OB1, 2026-05-20).
                    coords.x = pxX;
                    coords.y = pxY;
                    coords.unit = "pixels";
                }
                // fiber+native uses native tap — always verify
                let screenshot: TapScreenshot | undefined;
                let verification: TapVerification | undefined;
                let fnDpr: number | undefined;
                let fnDensity: number | undefined;
                if (platform === "ios") {
                    try {
                        const { getDevicePixelRatio } = await import("../core/ios.js");
                        fnDpr = await getDevicePixelRatio(targetUdid, beforeDims);
                    } catch { fnDpr = 3; }
                } else {
                    try {
                        const { androidGetDensity } = await import("../core/android.js");
                        const d = await androidGetDensity(targetSerial);
                        fnDensity = (d.density || 420) / 160;
                    } catch { fnDensity = undefined; }
                }
                const fiberMarker = computeMarkerPx({
                    strategy: "fiber+native",
                    convertedTo: coords,
                    platform,
                    screenshotScale: beforeScaleFactor || app?.lastScreenshot?.scaleFactor || 1,
                    devicePixelRatio: fnDpr,
                    androidDensityScale: fnDensity
                });
                if (options.burst && canVerify && beforeBuffer) {
                    ({ screenshot, verification } = await burstCaptureAndVerify({
                        platform,
                        beforeBuffer,
                        udid: targetUdid,
                        deviceId: targetSerial,
                        beforeScaleFactor,
                        markerPx: fiberMarker
                    }));
                } else {
                    ({ screenshot, verification } = await verifyAndCapture({
                        platform,
                        shouldVerify: canVerify,
                        shouldScreenshot: true,
                        beforeBuffer,
                        udid: targetUdid,
                        deviceId: targetSerial,
                        beforeScaleFactor,
                        markerPx: fiberMarker
                    }));
                }
                if (!shouldScreenshot && verification?.meaningful !== false) screenshot = undefined;
                if (screenshot && app) {
                    app.lastScreenshot = {
                        originalWidth: screenshot.width,
                        originalHeight: screenshot.height,
                        scaleFactor: screenshot.scaleFactor
                    };
                }
                const fiberSuccess = formatTapSuccess({
                    method: "fiber+native",
                    query,
                    pressed: result.pressed,
                    text: result.text,
                    path: result.path,
                    component: result.component,
                    convertedTo: coords,
                    platform,
                    device: deviceName,
                    deviceNote,
                    screenshot,
                    verification
                });
                const fiberLongPress = buildLongPressReport({
                    durationMs: options.duration,
                    hasLongPress: result.hasLongPress,
                    element: result.pressed
                });
                if (fiberLongPress) fiberSuccess.longPress = fiberLongPress;
                const fiberSwitch = await buildSwitchReport({
                    before: result.switchValue,
                    query,
                    index: options.index,
                    device: options.device,
                    element: result.pressed
                });
                if (fiberSwitch) fiberSuccess.switch = fiberSwitch;
                return fiberSuccess;
            } catch {
                // Native tap at fiber coordinates failed — continue to next strategy
            }
        }

        // Ambiguous fiber result — multiple elements matched, no index given.
        // Return immediately with the full list so the agent can decide.
        // Do NOT fall through to other strategies (they can't resolve ambiguity).
        if (result.matches && result.ambiguous) {
            const { screenshot: matchScreenshot } = shouldScreenshot
                ? await verifyAndCapture({ platform, shouldVerify: false, shouldScreenshot: true, beforeBuffer: null, udid: targetUdid, deviceId: targetSerial })
                : { screenshot: undefined };
            if (matchScreenshot && app) {
                app.lastScreenshot = {
                    originalWidth: matchScreenshot.width,
                    originalHeight: matchScreenshot.height,
                    scaleFactor: matchScreenshot.scaleFactor
                };
            }
            return formatTapFailure({
                query,
                attempted,
                error: `Ambiguous: ${result.matches.length} elements match this query. Tap did not execute.`,
                suggestion: `Specify index= (0–${result.matches.length - 1}) or add text= to narrow down. See matches[] for position and text of each element.`,
                device: deviceName,
                matches: result.matches,
                ambiguous: true,
                screenshot: matchScreenshot
            });
        }
    }

    // All strategies failed — check if the tap budget was the cause.
    // Only outer withTimeout wrapper messages or Skipped entries count; nested
    // sub-op errors that happen to contain "timed out" do not imply the tap
    // itself ran out of time.
    const hitTimeout = isTapTimeout(attempted);
    const elapsed = TAP_TIMEOUT_MS - remainingMs();

    // If fiber located the element but visibility filtered it out, prepend a
    // scroll-or-dismiss hint so the agent doesn't waste a turn assuming the
    // testID/component is missing.
    const fiberSawInvisible = attempted.some(a => a.strategy === "fiber" && a.outcome === "invisible");
    const allTimedOut = attempted.length > 0 && attempted.every(a => a.outcome === "timeout" || a.outcome === "skipped");
    let suggestion = buildSuggestion(query, strategies, platform);
    if (fiberSawInvisible) {
        suggestion = `Element exists in the React tree but is not on screen. Try scrolling it into view with swipe(), dismiss any overlay covering it, or wait for layout to settle. ` + suggestion;
    } else if (allTimedOut) {
        // No strategy got to a definitive answer — don't let the agent conclude
        // the element is missing. Steer toward retry or a different strategy.
        suggestion = `All strategies timed out — the element's presence is UNKNOWN. Retry the tap (transient slowness is common on dense screens), or try a different strategy explicitly (e.g. strategy='fiber' if accessibility timed out). ` + suggestion;
    }
    const { screenshot: failScreenshot } = shouldScreenshot
        ? await verifyAndCapture({ platform, shouldVerify: false, shouldScreenshot: true, beforeBuffer: null, udid: targetUdid, deviceId: targetSerial })
        : { screenshot: undefined };
    if (failScreenshot && app) {
        app.lastScreenshot = {
            originalWidth: failScreenshot.width,
            originalHeight: failScreenshot.height,
            scaleFactor: failScreenshot.scaleFactor
        };
    }
    // Pick the right error framing: a definitive "not found" is different from
    // "all strategies timed out — we don't know whether it exists".
    let errorOverride: string | undefined;
    if (hitTimeout) {
        errorOverride = `Tap timed out after ${elapsed}ms (budget ${TAP_TIMEOUT_MS}ms)`;
    } else if (allTimedOut) {
        errorOverride = `All tap strategies timed out before completing — element presence is UNKNOWN`;
    } else if (fiberSawInvisible) {
        errorOverride = `Element matches the query but is not visible on screen`;
    }
    const failureResult = formatTapFailure({
        query,
        attempted,
        error: errorOverride,
        suggestion,
        device: deviceName,
        screenshot: failScreenshot
    });
    // Before the artifact, so the verdict can ride into it — and before any
    // other recordScreen, because the diagnosis re-baselines as it decides.
    const staleness = diagnoseTapStaleness(deviceName, evidence);
    if (staleness) {
        failureResult.staleTag = staleness.tag;
        if (failureResult.error) failureResult.error = `${failureResult.error}\n${staleness.note}`;
    }
    const failSignals = await captureTapArtifact({
        query,
        outcome: "failure",
        errorMessage: failureResult.error,
        staleTag: staleness?.tag,
        attempted,
        platform,
        iosDriver: platform === "ios" ? (process.env.IOS_DRIVER?.toLowerCase() || "axe") : undefined,
        deviceName,
        screenshotMeta: failScreenshot ? { width: failScreenshot.width, height: failScreenshot.height } : undefined,
        screenshotBuffer: beforeBuffer,
        afterWithMarker: null,
        chosenTapPoint: null,
        evidence
    });
    return attachArtifactSignals(failureResult, failSignals);
}

// Matches testIDs typical of virtualized list items: trailing `-<digits>` (e.g. `store-item-0`,
// `route-item-6`) or containing a UUID v4 fragment (e.g. `group-card-e4566bc6-9164-4fd0-...`).
// Used by buildSuggestion() to tell the agent to scroll first when a list-item testID
// can't be found in the visible fiber tree.
const VIRTUALIZED_TESTID_RE = /(-\d+$)|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function looksLikeVirtualizedListItem(testID: string): boolean {
    return VIRTUALIZED_TESTID_RE.test(testID);
}

function buildSuggestion(query: TapQuery, triedStrategies: string[], platform: string): string {
    const suggestions: string[] = [];

    if (!triedStrategies.includes("ocr") && query.text) {
        suggestions.push("Try strategy='ocr' to find text visually on screen");
    }

    if (query.text && query.text.length <= 2) {
        suggestions.push("Very short text is unreliable for OCR — use testID or coordinates instead");
    }

    if (query.text && hasProblematicUnicode(query.text)) {
        suggestions.push("Emoji text cannot use fiber strategy — use testID or coordinates instead");
    }

    if (query.component && triedStrategies.includes("fiber")) {
        suggestions.push(
            "Component not found or has no onPress handler — use find_components to discover exact component names, or use text/coordinates instead"
        );
    }

    if (query.testID && !triedStrategies.includes("ocr")) {
        suggestions.push(
            "testID not found in fiber/accessibility tree — verify the element is on the current screen with a screenshot"
        );
    }

    // List-item testIDs (suffix `-N` or containing a UUID) are typically rendered inside a
    // virtualized list — items beyond the viewport are unmounted, so the fiber tree genuinely
    // doesn't contain them. Adding the hint as a separate suggestion (rather than rewriting
    // the error) keeps the existing message stable for tooling that parses it.
    if (query.testID && looksLikeVirtualizedListItem(query.testID)) {
        suggestions.push(
            "testID looks like a virtualized list item — scroll it on-screen first " +
            `(swipe()${platform === "ios" ? " or ios_button arrow keys" : ""}) before tapping`
        );
    }

    suggestions.push(
        `Take a screenshot (${platform === "ios" ? "ios_screenshot" : "android_screenshot"}) ` +
            "to verify the element is visible, then use x/y coordinates"
    );

    return suggestions.join(". ");
}
