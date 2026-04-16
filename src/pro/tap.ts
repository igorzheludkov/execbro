import { connectedApps, imageBuffer } from "../core/state.js";
import type { ConnectedApp } from "../core/types.js";
import type { OCRResult } from "../core/ocr.js";
import { executeInApp } from "../core/executor.js";
import { pressElement } from "../core/executor.js";
import {
    iosTap,
    iosFindElement,
    iosScreenshot,
    getActiveOrBootedSimulatorUdid,
    findSimulatorByName,
    isUiDriverAvailable,
    getUiDriverInstallHint
} from "../core/ios.js";
import { androidTap, androidFindElement, getDefaultAndroidDevice, androidScreenshot } from "../core/android.js";
import { compareScreenshots } from "./screenshot-diff.js";
import { scanMetroPorts, fetchDevices, selectMainDevice } from "../core/metro.js";
import { connectToDevice, clearReconnectionSuppression } from "../core/connection.js";
import { notifyDriverMissing } from "../core/logbox.js";

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
    platform?: "ios" | "android";
    screenshot?: boolean;
    verify?: boolean;
    burst?: boolean;
}

export interface TapAttempt {
    strategy: string;
    reason: string;
}

export interface TapScreenshot {
    image: string;
    width: number;
    height: number;
    scaleFactor: number;
}

export interface TapVerification {
    meaningful: boolean;
    changeRate: number;
    changedPixels: number;
    totalPixels: number;
    transientChangeDetected?: boolean;
    peakChangeRate?: number;
    peakFrame?: number;
    burstGroupId?: string;
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
}): string {
    const pct = (rate: number) => (rate * 100).toFixed(1) + "%";

    if (v.meaningful && !v.transientChangeDetected) {
        return `Tap caused a visible UI change (${pct(v.changeRate)} pixel diff). The screen updated as expected.`;
    }

    if (v.meaningful && v.transientChangeDetected) {
        return (
            `No persistent change, but transient visual feedback detected ` +
            `(frame ${v.peakFrame} peak ${pct(v.peakChangeRate || 0)} diff). ` +
            `Tap triggered a press animation that settled back to original state.`
        );
    }

    if (v.transientChangeDetected === false) {
        return (
            `No visual change detected — neither persistent nor transient across burst frames. ` +
            `The element may not respond visually or the tap may have missed.`
        );
    }

    return (
        `No visual change detected between before and after screenshots. ` +
        `The element may not respond visually or the tap may have missed.`
    );
}

export interface BurstAnalysis {
    meaningful: boolean;
    persistentChangeRate: number;
    transientChangeDetected: boolean;
    peakChangeRate: number;
    peakFrame: number;
    framesWithChange: number[];
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
            framesWithChange: []
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
    const meaningful = persistentDiff.changed || transientChangeDetected;

    return {
        meaningful,
        persistentChangeRate,
        transientChangeDetected,
        peakChangeRate,
        peakFrame,
        framesWithChange
    };
}

export interface TapResult {
    success: boolean;
    method?: string;
    query: TapQuery;
    pressed?: string;
    text?: string;
    screen?: string | null;
    path?: string | null;
    component?: string | null;
    tappedAt?: { x: number; y: number };
    convertedTo?: { x: number; y: number; unit: string };
    platform?: string;
    device?: string;
    error?: string;
    attempted?: TapAttempt[];
    matches?: Array<{ index: number; component: string; text: string }>;
    suggestion?: string;
    screenshot?: TapScreenshot;
    verification?: TapVerification;
    warning?: string;
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

export async function getCurrentScreen(): Promise<string | null> {
  try {
      // Note: Uses var instead of let/const because Hermes Runtime.evaluate
      // sometimes has issues with block-scoped declarations
      const expression = `(function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return null;
            var roots = [];
            if (hook.getFiberRoots) {
                hook.renderers.forEach(function(r, id) {
                    var fiberRoots = hook.getFiberRoots(id);
                    if (fiberRoots) fiberRoots.forEach(function(root) { roots.push(root); });
                });
            }
            if (roots.length === 0) return null;

            function findScreen(fiber, depth) {
                if (!fiber || depth > 5000) return null;
                var name = fiber.type && (fiber.type.displayName || fiber.type.name || (typeof fiber.type === 'string' ? fiber.type : null));

                if (name === 'RNSScreen') {
                    var props = fiber.memoizedProps || {};
                    if (props['aria-hidden'] === true) return null;
                    var child = fiber.child;
                    while (child) {
                        var childName = child.type && (child.type.displayName || child.type.name);
                        if (childName && typeof child.type !== 'string' && childName !== 'RNSScreenContentWrapper') {
                            return childName;
                        }
                        child = child.child;
                    }
                }

                var child = fiber.child;
                while (child) {
                    var found = findScreen(child, depth + 1);
                    if (found) return found;
                    child = child.sibling;
                }
                return null;
            }

            for (var i = 0; i < roots.length; i++) {
                var root = roots[i].current;
                var screen = findScreen(root, 0);
                if (screen) return screen;
            }

            function findFirstUserComponent(fiber, depth) {
                if (!fiber || depth > 5000) return null;
                var name = fiber.type && (fiber.type.displayName || fiber.type.name);
                if (name && typeof fiber.type !== 'string') return name;
                var child = fiber.child;
                while (child) {
                    var found = findFirstUserComponent(child, depth + 1);
                    if (found) return found;
                    child = child.sibling;
                }
                return null;
            }

            for (var i = 0; i < roots.length; i++) {
                var fallback = findFirstUserComponent(roots[i].current, 0);
                if (fallback) return fallback;
            }
            return null;
        })()`;

      const result = await executeInApp(expression, false);
      if (result.success && result.result && result.result !== "null" && result.result !== "undefined") {
          return result.result.replace(/^"|"$/g, "");
      }
      return null;
  } catch {
      return null;
  }
}

export function formatTapSuccess(data: {
    method: string;
    query: TapQuery;
    pressed?: string;
    text?: string;
    screen?: string | null;
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
    return {
        success: true,
        ...rest,
        ...(verification && { verification }),
        ...(screenshot && { screenshot })
    };
}

export function formatTapFailure(data: {
    query: TapQuery;
    screen?: string | null;
    error?: string;
    attempted: TapAttempt[];
    suggestion: string;
    device?: string;
    matches?: Array<{ index: number; component: string; text: string }>;
    screenshot?: TapScreenshot;
    verification?: TapVerification;
}): TapResult {
    const errorMsg = data.error || buildErrorMessage(data.query);
    const warning =
        data.verification && !data.verification.meaningful
            ? "Tap executed but no visual change detected. The element may not exist at these coordinates. Examine the screenshot to verify and retry with adjusted coordinates."
            : undefined;
    const lastStrategy = data.attempted.length > 0 ? data.attempted[data.attempted.length - 1].strategy : undefined;
    return {
        success: false,
        method: lastStrategy,
        query: data.query,
        screen: data.screen,
        error: errorMsg,
        attempted: data.attempted,
        suggestion: data.suggestion,
        matches: data.matches,
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

// --- Strategy Result ---

interface StrategyResult {
    success: boolean;
    reason: string;
    pressed?: string;
    text?: string;
    screen?: string | null;
    path?: string | null;
    component?: string | null;
    matches?: Array<{ index: number; component: string; text: string }>;
    convertedTo?: { x: number; y: number; unit: string };
}

// --- Strategy Functions ---

async function tryFiberStrategy(query: TapQuery, index?: number, maxTraversalDepth?: number): Promise<StrategyResult> {
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
        const result = await tryFiberAtDepth(query, index, depth);
        if (result.success || result.matches) {
            return result;
        }
        lastResult = result;
    }

    return lastResult!;
}

async function tryFiberAtDepth(
    query: TapQuery,
    index: number | undefined,
    maxTraversalDepth: number
): Promise<StrategyResult> {
    try {
        const result = await pressElement({
            text: query.text,
            testID: query.testID,
            component: query.component,
            index,
            maxTraversalDepth
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
    udid?: string
): Promise<StrategyResult> {
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
                result = await iosFindElement(
                    {
                        labelContains: searchText,
                        index
                    },
                    udid
                );
            }

            if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                return {
                    success: false,
                    reason: result.error ?? "No iOS accessibility match"
                };
            }

            const match = result.allMatches[index ?? 0];
            if (!match) {
                return {
                    success: false,
                    reason: `Index ${index} out of bounds (${result.allMatches.length} matches)`
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

            let result = await androidFindElement(searchOptions);

            // If testID search via resourceId failed, try contentDescContains
            // (older RN versions map testID to content-description)
            if (hasTestID && !hasText && (!result.success || !result.allMatches || result.allMatches.length === 0)) {
                result = await androidFindElement({
                    contentDescContains: query.testID,
                    index
                });
            }

            if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                return {
                    success: false,
                    reason: result.error ?? "No Android accessibility match"
                };
            }

            const match = result.allMatches[index ?? 0];
            if (!match) {
                return {
                    success: false,
                    reason: `Index ${index} out of bounds (${result.allMatches.length} matches)`
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
    }
}

async function tryOcrStrategy(query: TapQuery, platform: "ios" | "android", udid?: string): Promise<StrategyResult> {
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
            const screenshot = await androidScreenshot();
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
            platform
        });

        const match = findOcrMatch(ocrResult, searchText);

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

            // Best-effort: identify what was tapped via fiber tree
            let screen: string | null = null;
            try {
                screen = await getCurrentScreen();
            } catch {
                // Inspection failure is non-fatal
            }
            return {
                success: true,
                reason: "Tapped at coordinates (iOS)",
                screen,
                convertedTo: { x: converted.x, y: converted.y, unit: "points" }
            };
        } else {
            const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
            const converted = convertScreenshotToTapCoords(pixelX, pixelY, "android", 1, scaleFactor);
            await androidTap(converted.x, converted.y);

            // Best-effort: identify what was tapped via fiber tree
            let screen: string | null = null;
            try {
                screen = await getCurrentScreen();
            } catch {
                // Inspection failure is non-fatal
            }
            return {
                success: true,
                reason: "Tapped at coordinates (Android)",
                screen,
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

const SETTLE_DELAY_MS = 800;
const TAP_TIMEOUT_MS = 20000;
const MIN_STRATEGY_BUDGET_MS = 500;
const MAX_STRATEGY_MS: Record<string, number> = {
    fiber: 5000,
    accessibility: 3000,
    ocr: 5000,
    coordinate: 3000
};

// Matches only the outer withTimeout wrapper message for a tap strategy.
// Nested sub-operation errors inside a strategy (e.g. "CDP getProperties timed out after 150ms")
// must NOT be classified as a tap-level timeout.
const STRATEGY_TIMEOUT_RE = /^(fiber|accessibility|ocr|coordinate) timed out after \d+ms$/;

export function isTapTimeout(attempted: readonly { reason: string; strategy?: string }[]): boolean {
    return attempted.some(
        (a) => STRATEGY_TIMEOUT_RE.test(a.reason) || a.reason.startsWith("Skipped —")
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

async function captureScreenshot(
    platform: "ios" | "android",
    udid?: string
): Promise<{
    buffer: Buffer;
    width: number;
    height: number;
    scaleFactor: number;
} | null> {
    try {
        const result = platform === "ios" ? await iosScreenshot(undefined, udid) : await androidScreenshot();
        if (!result.success || !result.data) return null;
        return {
            buffer: result.data,
            width: result.originalWidth || 0,
            height: result.originalHeight || 0,
            scaleFactor: result.scaleFactor || 1
        };
    } catch {
        return null;
    }
}

function screenshotToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

async function verifyAndCapture(
    platform: "ios" | "android",
    shouldVerify: boolean,
    shouldScreenshot: boolean,
    beforeBuffer: Buffer | null,
    udid?: string,
    beforeScaleFactor?: number
): Promise<{ screenshot?: TapScreenshot; verification?: TapVerification }> {
    if (!shouldScreenshot) return {};

    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

    const after = await captureScreenshot(platform, udid);
    if (!after) return {};

    const screenshot: TapScreenshot = {
        image: screenshotToBase64(after.buffer),
        width: after.width,
        height: after.height,
        scaleFactor: after.scaleFactor
    };

    let verification: TapVerification | undefined;
    if (shouldVerify && beforeBuffer) {
        try {
            const rawStatusBar = platform === "ios" ? 177 : 142; // pixels in original screenshot space
            const scale = beforeScaleFactor || after.scaleFactor || 1;
            const statusBarHeight = Math.round(rawStatusBar / scale);
            const diff = await compareScreenshots(beforeBuffer, after.buffer, {
                statusBarHeight
            });
            verification = {
                meaningful: diff.changed,
                changeRate: diff.changeRate,
                changedPixels: diff.changedPixels,
                totalPixels: diff.totalPixels,
                explanation: buildVerificationExplanation({
                    meaningful: diff.changed,
                    changeRate: diff.changeRate,
                    changedPixels: diff.changedPixels,
                    totalPixels: diff.totalPixels
                })
            };
        } catch {
            // Diff failed — still return the screenshot
        }
    }

    const verifyGroupId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (beforeBuffer) {
        imageBuffer.add({
            id: `${verifyGroupId}-before`,
            image: beforeBuffer,
            timestamp: Date.now(),
            source: "tap-verify",
            groupId: verifyGroupId,
            metadata: { phase: "before" }
        });
    }
    imageBuffer.add({
        id: `${verifyGroupId}-after`,
        image: after.buffer,
        timestamp: Date.now(),
        source: "tap-verify",
        groupId: verifyGroupId,
        metadata: { phase: "after", changeRate: verification?.changeRate }
    });

    return { screenshot, verification };
}

// --- Burst Capture ---

const BURST_FRAME_COUNT = 4;
const BURST_FRAME_INTERVAL_MS = 150;

async function burstCaptureAndVerify(
    platform: "ios" | "android",
    beforeBuffer: Buffer | null,
    udid?: string,
    beforeScaleFactor?: number
): Promise<{ screenshot?: TapScreenshot; verification?: TapVerification }> {
    if (!beforeBuffer) return {};

    const frames: Buffer[] = [beforeBuffer];
    let capturedScaleFactor = beforeScaleFactor || 1;

    for (let i = 0; i < BURST_FRAME_COUNT; i++) {
        await new Promise((resolve) => setTimeout(resolve, BURST_FRAME_INTERVAL_MS));
        const capture = await captureScreenshot(platform, udid);
        if (capture) {
            frames.push(capture.buffer);
            if (i === 0) capturedScaleFactor = capture.scaleFactor || capturedScaleFactor;
        }
    }

    if (frames.length < 2) return {};

    const rawStatusBar = platform === "ios" ? 177 : 142; // pixels in original screenshot space
    const statusBarHeight = Math.round(rawStatusBar / capturedScaleFactor);
    const analysis = await analyzeBurstFrames(frames, { statusBarHeight });

    const groupId = `burst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < frames.length; i++) {
        imageBuffer.add({
            id: `${groupId}-f${i}`,
            image: frames[i],
            timestamp: Date.now(),
            source: "tap-burst",
            groupId,
            metadata: {
                frameIndex: i,
                isBefore: i === 0,
                changeRate: i === 0 ? 0 : analysis.framesWithChange.includes(i) ? analysis.peakChangeRate : 0
            }
        });
    }

    imageBuffer.addGroup({
        groupId,
        intent: "tap-verification",
        source: "tap-burst",
        timestamp: Date.now(),
        frameCount: frames.length,
        summary: {
            peakChangeRate: analysis.peakChangeRate,
            peakFrame: analysis.peakFrame,
            framesWithChange: analysis.framesWithChange,
            transientChangeDetected: analysis.transientChangeDetected,
            persistentChangeRate: analysis.persistentChangeRate
        }
    });

    // Get dimensions from the last frame using sharp
    const sharp = (await import("sharp")).default;
    const meta = await sharp(frames[frames.length - 1]).metadata();
    const screenshot: TapScreenshot = {
        image: screenshotToBase64(frames[frames.length - 1]),
        width: meta.width || 0,
        height: meta.height || 0,
        scaleFactor: 1
    };

    const verification: TapVerification = {
        meaningful: analysis.meaningful,
        changeRate: analysis.persistentChangeRate,
        changedPixels: 0,
        totalPixels: 0,
        transientChangeDetected: analysis.transientChangeDetected,
        peakChangeRate: analysis.peakChangeRate,
        peakFrame: analysis.peakFrame,
        burstGroupId: groupId,
        explanation: buildVerificationExplanation({
            meaningful: analysis.meaningful,
            changeRate: analysis.persistentChangeRate,
            changedPixels: 0,
            totalPixels: 0,
            transientChangeDetected: analysis.transientChangeDetected,
            peakChangeRate: analysis.peakChangeRate,
            peakFrame: analysis.peakFrame
        })
    };

    return { screenshot, verification };
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
        let platform = options.platform as "ios" | "android" | undefined;

        // Auto-detect platform if not specified
        let nativeUdid: string | undefined;
        if (!platform) {
            const [androidDevice, iosSimulator] = await Promise.all([
                getDefaultAndroidDevice().catch(() => null),
                getActiveOrBootedSimulatorUdid().catch(() => null)
            ]);
            if (androidDevice && iosSimulator) {
                return {
                    success: false,
                    query,
                    error: 'Multiple platforms detected (both Android and iOS). Specify platform: "android" or platform: "ios" to target the correct device.'
                };
            }
            if (androidDevice) {
                platform = "android";
            } else if (iosSimulator) {
                platform = "ios";
                nativeUdid = iosSimulator;
            } else {
                return {
                    success: false,
                    query,
                    error: "No Android device or iOS simulator found. Connect a device or start a simulator."
                };
            }
        } else if (platform === "ios") {
            nativeUdid = (await getActiveOrBootedSimulatorUdid()) ?? undefined;
        }

        const nativeShouldScreenshot = options.screenshot !== false;
        const nativeShouldVerify = nativeShouldScreenshot && options.verify !== false;
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
            if (options.burst && nativeShouldVerify && nativeBeforeBuffer) {
                ({ screenshot, verification } = await burstCaptureAndVerify(
                    platform,
                    nativeBeforeBuffer,
                    nativeUdid,
                    nativeScreenshotMeta?.scaleFactor
                ));
            } else {
                ({ screenshot, verification } = await verifyAndCapture(
                    platform,
                    nativeShouldVerify,
                    nativeShouldScreenshot,
                    nativeBeforeBuffer,
                    nativeUdid,
                    nativeScreenshotMeta?.scaleFactor
                ));
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

    // Detect available capabilities
    const allApps = Array.from(connectedApps.values());
    let hasMetro = allApps.length > 0;
    // If platform is specified, prefer an app matching that platform
    let app: ConnectedApp | undefined = options.platform
        ? (allApps.find((a) => a.platform === options.platform) ?? allApps[0])
        : allApps[0];

    // Try to auto-connect to Metro (for fiber strategy), but don't fail if it doesn't work
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
            app = apps[0];
        } catch {
            // Auto-connect failed — Metro-dependent strategies will be skipped
        }
    }

    // Detect platform — from Metro connection or from available devices
    let platform = options.platform as "ios" | "android" | undefined;
    if (!platform) {
        if (app) {
            platform = app.platform;
        } else {
            // No Metro — detect from available devices
            const [androidDevice, iosSimulator] = await Promise.all([
                getDefaultAndroidDevice().catch(() => null),
                getActiveOrBootedSimulatorUdid().catch(() => null)
            ]);
            if (androidDevice && iosSimulator) {
                return {
                    success: false,
                    query,
                    error: 'Both iOS and Android devices detected but no Metro connection. Specify platform="ios" or platform="android".'
                };
            }
            if (androidDevice) platform = "android";
            else if (iosSimulator) platform = "ios";
        }
    }

    if (!platform) {
        return {
            success: false,
            query,
            error: "No devices found. Boot a simulator or connect an Android device."
        };
    }

    // Resolve target iOS simulator UDID from the connected app
    // This ensures taps go to the correct device when multiple simulators are booted
    let targetUdid: string | undefined;
    if (platform === "ios") {
        targetUdid =
            app?.simulatorUdid ??
            (app?.deviceInfo?.deviceName ? await findSimulatorByName(app.deviceInfo.deviceName) : null) ??
            undefined;
    }

    const deviceName = app?.deviceInfo?.deviceName;

    // Determine strategies
    const strategies = getAvailableStrategies(query, strategy);
    const attempted: TapAttempt[] = [];

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
                reason: "Skipped — no Metro connection (required for fiber)"
            });
            return false;
        }
        if (uiDriverMissing && UI_DRIVER_REQUIRED_STRATEGIES.includes(strat)) {
            attempted.push({
                strategy: strat,
                reason: "Skipped — iOS UI driver is not installed (required for iOS tap/accessibility/OCR)"
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

    // Determine screenshot and verification behavior
    const shouldScreenshot = options.screenshot !== false;
    // Always capture before screenshot when screenshots are enabled and verify isn't explicitly off
    // Verification decision is deferred until we know which strategy actually succeeded
    const canVerify = shouldScreenshot && options.verify !== false;

    // Capture "before" screenshot for verification
    let beforeBuffer: Buffer | null = null;
    let beforeScaleFactor: number | undefined;
    if (canVerify) {
        const before = await captureScreenshot(platform, targetUdid);
        beforeBuffer = before?.buffer || null;
        beforeScaleFactor = before?.scaleFactor;
    }

    // Execute strategies in order with per-strategy caps and overall budget
    for (const strat of filteredStrategies) {
        const remaining = remainingMs();
        if (remaining < MIN_STRATEGY_BUDGET_MS) {
            attempted.push({
                strategy: strat,
                reason: `Skipped — only ${remaining}ms remaining (budget ${TAP_TIMEOUT_MS}ms)`
            });
            continue;
        }

        const cap = MAX_STRATEGY_MS[strat] ?? 5000;
        const budget = Math.min(cap, remaining);

        let result: StrategyResult;

        try {
            switch (strat) {
                case "fiber":
                    result = await withTimeout(tryFiberStrategy(query, index, maxTraversalDepth), budget, `fiber`);
                    break;
                case "accessibility":
                    result = await withTimeout(
                        tryAccessibilityStrategy(query, index, platform, targetUdid),
                        budget,
                        `accessibility`
                    );
                    break;
                case "ocr":
                    result = await withTimeout(tryOcrStrategy(query, platform, targetUdid), budget, `ocr`);
                    break;
                case "coordinate":
                    result = await withTimeout(
                        tryCoordinateStrategy(query.x!, query.y!, platform, app?.lastScreenshot, targetUdid),
                        budget,
                        `coordinate`
                    );
                    break;
                default:
                    result = { success: false, reason: `Unknown strategy: ${strat}` };
            }
        } catch (err) {
            attempted.push({
                strategy: strat,
                reason: err instanceof Error ? err.message : String(err)
            });
            continue;
        }

        if (result.success) {
            let screenshot: TapScreenshot | undefined;
            let verification: TapVerification | undefined;
            if (options.burst && canVerify && beforeBuffer) {
                ({ screenshot, verification } = await burstCaptureAndVerify(
                    platform,
                    beforeBuffer,
                    targetUdid,
                    beforeScaleFactor
                ));
            } else {
                ({ screenshot, verification } = await verifyAndCapture(
                    platform,
                    canVerify,
                    shouldScreenshot,
                    beforeBuffer,
                    targetUdid,
                    beforeScaleFactor
                ));
            }
            if (screenshot && app) {
                app.lastScreenshot = {
                    originalWidth: screenshot.width,
                    originalHeight: screenshot.height,
                    scaleFactor: screenshot.scaleFactor
                };
            }
            return formatTapSuccess({
                method: strat,
                query,
                pressed: result.pressed,
                text: result.text,
                screen: result.screen,
                path: result.path,
                component: result.component,
                convertedTo: result.convertedTo,
                platform,
                device: deviceName,
                screenshot,
                verification
            });
        }

        attempted.push({ strategy: strat, reason: result.reason });

        // If fiber found an element with measured coordinates, do a native tap directly
        if (strat === "fiber" && result.convertedTo && result.pressed) {
            try {
                const coords = result.convertedTo;
                if (platform === "ios") {
                    // Fabric returns points — iosTap expects points
                    await iosTap(coords.x, coords.y, { udid: targetUdid });
                } else {
                    // Fabric returns dp — androidTap expects pixels
                    // Convert dp to pixels using device density
                    const { androidGetDensity } = await import("../core/android.js");
                    const densityResult = await androidGetDensity();
                    const densityScale = (densityResult.density || 420) / 160;
                    await androidTap(Math.round(coords.x * densityScale), Math.round(coords.y * densityScale));
                }
                // fiber+native uses native tap — always verify
                let screenshot: TapScreenshot | undefined;
                let verification: TapVerification | undefined;
                if (options.burst && canVerify && beforeBuffer) {
                    ({ screenshot, verification } = await burstCaptureAndVerify(
                        platform,
                        beforeBuffer,
                        targetUdid,
                        beforeScaleFactor
                    ));
                } else {
                    ({ screenshot, verification } = await verifyAndCapture(
                        platform,
                        canVerify,
                        shouldScreenshot,
                        beforeBuffer,
                        targetUdid,
                        beforeScaleFactor
                    ));
                }
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

        // If we got match suggestions from fiber, carry them forward
        if (result.matches) {
            const { screenshot: matchScreenshot } = shouldScreenshot
                ? await verifyAndCapture(platform, false, true, null, targetUdid)
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
                suggestion: `Found ${result.matches.length} match(es) — specify index to select one`,
                device: deviceName,
                matches: result.matches,
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

    const suggestion = buildSuggestion(query, strategies, platform);
    const { screenshot: failScreenshot } = shouldScreenshot
        ? await verifyAndCapture(platform, false, true, null, targetUdid)
        : { screenshot: undefined };
    if (failScreenshot && app) {
        app.lastScreenshot = {
            originalWidth: failScreenshot.width,
            originalHeight: failScreenshot.height,
            scaleFactor: failScreenshot.scaleFactor
        };
    }
    return formatTapFailure({
        query,
        attempted,
        error: hitTimeout ? `Tap timed out after ${elapsed}ms (budget ${TAP_TIMEOUT_MS}ms)` : undefined,
        suggestion,
        device: deviceName,
        screenshot: failScreenshot
    });
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

    suggestions.push(
        `Take a screenshot (${platform === "ios" ? "ios_screenshot" : "android_screenshot"}) ` +
            "to verify the element is visible, then use x/y coordinates"
    );

    return suggestions.join(". ");
}
