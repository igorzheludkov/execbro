import { connectedApps } from "../core/state.js";
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
        return `${Action} caused a visible UI change (${pct(v.changeRate)} pixel diff). The screen updated as expected.`;
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
        return `${Action} caused a visible UI change (${pct(v.changeRate)} pixel diff). The screen updated as expected.`;
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
    // Failure-artifact signals (populated by captureFailureArtifact when outcome warrants).
    // Forwarded to telemetry blobs 16-20 by the index.ts wrapper.
    artifactKey?: string;
    ocrClosestMatch?: string;
    fiberPressableCount?: string;
    accessibilityMatchCount?: string;
    appRoute?: string;
}

// --- Helpers ---

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
    height: number
): { startX: number; startY: number; endX: number; endY: number } {
    const vertical = direction === "up" || direction === "down";
    const axis = vertical ? height : width;
    const d = distance && distance > 0 ? distance : Math.round(0.33 * axis);

    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const lo = Math.round(0.1 * axis);
    const hi = Math.round(0.9 * axis);

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
        ? "TextInput focused but no visual change detected. If the simulator has a hardware keyboard connected (Cmd+K), the software keyboard is suppressed even though the input is focused — proceed with text entry via ios_input_text / android_input_text."
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

async function tryFiberStrategy(query: TapQuery, index?: number, maxTraversalDepth?: number, sink?: EvidenceSink, device?: string): Promise<StrategyResult> {
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
            const result = await tryFiberAtDepth(query, index, depth, device);
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
    device?: string
): Promise<StrategyResult> {
    try {
        const result = await pressElement({
            text: query.text,
            testID: query.testID,
            component: query.component,
            index,
            maxTraversalDepth,
            device
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
                    }
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
    signal?: AbortSignal
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
                    udid
                );
                // Fall back to identifierContains if exact match fails
                if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                    result = await iosFindElement(
                        {
                            identifierContains: query.testID,
                            index
                        },
                        udid
                    );
                }
                // Last resort: try labelContains in case testID is reflected in label
                if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                    result = await iosFindElement(
                        {
                            labelContains: query.testID,
                            index
                        },
                        udid
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
                    udid
                );
                if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                    result = await iosFindElement(
                        {
                            labelContains: searchText,
                            index
                        },
                        udid
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

            await iosTap(match.center.x, match.center.y, { udid });

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

            let result = await androidFindElement(searchOptions, undefined, signal);

            // If testID search via resourceId failed, try contentDescContains
            // (older RN versions map testID to content-description)
            if (hasTestID && !hasText && (!result.success || !result.allMatches || result.allMatches.length === 0)) {
                result = await androidFindElement({
                    contentDescContains: query.testID,
                    index
                }, undefined, signal);
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

            await androidTap(match.center.x, match.center.y);

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
async function tryOcrStrategy(query: TapQuery, platform: "ios" | "android", udid?: string, sink?: EvidenceSink, signal?: AbortSignal): Promise<StrategyResult> {
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
            const screenshot = await androidScreenshot(undefined, undefined, signal);
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
                { udid }
            );
            if (!tapResult.success) {
                return {
                    success: false,
                    reason: `OCR found "${match.text}" but tap failed: ${tapResult.error}`
                };
            }
        } else {
            // Android: image-pixel → device-pixel (undo downscale), ADB accepts pixels
            await androidTap(
                Math.round(match.tapCenter.x * scaleFactor),
                Math.round(match.tapCenter.y * scaleFactor)
            );
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
    udid?: string
): Promise<StrategyResult> {
    try {
        if (platform === "ios") {
            const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
            const { getDevicePixelRatio } = await import("../core/ios.js");
            const devicePixelRatio = await getDevicePixelRatio(udid);

            const converted = convertScreenshotToTapCoords(pixelX, pixelY, "ios", devicePixelRatio, scaleFactor);
            const tapResult = await iosTap(converted.x, converted.y, { udid });
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
            await androidTap(converted.x, converted.y);

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

async function captureTapArtifact(ctx: ArtifactCaptureContext): Promise<CaptureSignals | undefined> {
    try {
        const { getServerVersion, categorizeError } = await import("../core/telemetry.js");
        const strategyChain = ctx.attempted.map(a => `${a.strategy}:${a.reason.slice(0, 40)}`).join("|");

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

        const nativeShouldScreenshot = options.screenshot !== false;
        // Decoupled (I5, 2026-05-16): verify runs even when image bytes aren't returned.
        const nativeShouldVerify = options.verify !== false;
        let nativeBeforeBuffer: Buffer | null = null;
        let nativeScreenshotMeta: { originalWidth: number; originalHeight: number; scaleFactor: number } | undefined;
        if (nativeShouldVerify) {
            const before = await captureScreenshot(platform, nativeUdid);
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
            const ref = await captureScreenshot(platform, nativeUdid);
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
                tryCoordinateStrategy(query.x!, query.y!, platform, nativeScreenshotMeta, nativeUdid),
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
                    beforeScaleFactor: nativeScreenshotMeta?.scaleFactor,
                    markerPx: nativeMarker
                }));
            }
            return formatTapSuccess({
                method: "native-coordinate",
                query,
                pressed: result.pressed,
                convertedTo: result.convertedTo,
                platform,
                screenshot,
                verification
            });
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
    const platform: "ios" | "android" = resolved.target.platform;
    let targetUdid: string | undefined = resolved.target.iosUdid;

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
    {
        const before = await captureScreenshot(platform, targetUdid);
        beforeBuffer = before?.buffer || null;
        beforeScaleFactor = before?.scaleFactor;
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
    for (const strat of filteredStrategies) {
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
                    result = await withTimeout(tryFiberStrategy(query, index, maxTraversalDepth, evidence, deviceName), budget, `fiber`);
                    break;
                case "accessibility":
                    result = await withCancelableTimeout(
                        (signal) => tryAccessibilityStrategy(query, index, platform, targetUdid, evidence, signal),
                        budget,
                        `accessibility`
                    );
                    break;
                case "ocr":
                    result = await withCancelableTimeout(
                        (signal) => tryOcrStrategy(query, platform, targetUdid, evidence, signal),
                        budget,
                        `ocr`
                    );
                    break;
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
                                ? { originalWidth: 0, originalHeight: 0, scaleFactor: beforeScaleFactor }
                                : app?.lastScreenshot,
                            targetUdid
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
                    dprForMarker = await getDevicePixelRatio(targetUdid);
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
                screenshot,
                verification
            });
            // Capture an artifact for "successful but unmeaningful" taps so we can
            // diagnose taps that landed wrong or hit non-responsive elements.
            // Uses the same `meaningful` flag the agent sees so dashboard outcomes
            // stay consistent with what the caller observed.
            if (verification && !verification.skipped && verification.meaningful === false) {
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
                    await iosTap(coords.x, tapY, { udid: targetUdid });
                    coords.y = tapY;
                } else {
                    // Fabric returns dp — androidTap expects pixels
                    // Convert dp to pixels using device density
                    const { androidGetDensity } = await import("../core/android.js");
                    const densityResult = await androidGetDensity();
                    const densityScale = (densityResult.density || 420) / 160;
                    const pxX = Math.round(coords.x * densityScale);
                    const pxY = Math.round(coords.y * densityScale);
                    await androidTap(pxX, pxY);
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
                        fnDpr = await getDevicePixelRatio(targetUdid);
                    } catch { fnDpr = 3; }
                } else {
                    try {
                        const { androidGetDensity } = await import("../core/android.js");
                        const d = await androidGetDensity();
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
                return formatTapSuccess({
                    method: "fiber+native",
                    query,
                    pressed: result.pressed,
                    text: result.text,
                    path: result.path,
                    component: result.component,
                    convertedTo: coords,
                    platform,
                    device: deviceName,
                    screenshot,
                    verification
                });
            } catch {
                // Native tap at fiber coordinates failed — continue to next strategy
            }
        }

        // Ambiguous fiber result — multiple elements matched, no index given.
        // Return immediately with the full list so the agent can decide.
        // Do NOT fall through to other strategies (they can't resolve ambiguity).
        if (result.matches && result.ambiguous) {
            const { screenshot: matchScreenshot } = shouldScreenshot
                ? await verifyAndCapture({ platform, shouldVerify: false, shouldScreenshot: true, beforeBuffer: null, udid: targetUdid })
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
        ? await verifyAndCapture({ platform, shouldVerify: false, shouldScreenshot: true, beforeBuffer: null, udid: targetUdid })
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
    const failSignals = await captureTapArtifact({
        query,
        outcome: "failure",
        errorMessage: failureResult.error,
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
