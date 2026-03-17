import { connectedApps } from "./state.js";
import { inferIOSDevicePixelRatio } from "./ocr.js";
import { executeInApp } from "./executor.js";
import { pressElement } from "./executor.js";
import { iosTap, iosFindElement, iosScreenshot } from "./ios.js";
import { androidTap, androidFindElement } from "./android.js";
import { scanMetroPorts, fetchDevices, selectMainDevice } from "./metro.js";
import { connectToDevice, clearReconnectionSuppression } from "./connection.js";

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
}

export interface TapAttempt {
    strategy: string;
    reason: string;
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
    error?: string;
    attempted?: TapAttempt[];
    matches?: Array<{ index: number; component: string; text: string }>;
    suggestion?: string;
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

export function isNonAscii(text: string): boolean {
    return /[^\x00-\x7F]/.test(text);
}

export function getAvailableStrategies(
    query: TapQuery,
    strategy: TapStrategy
): string[] {
    if (query.x !== undefined && query.y !== undefined) {
        return ["coordinate"];
    }
    if (strategy !== "auto") {
        return [strategy];
    }
    if (query.component && !query.text && !query.testID) {
        return ["fiber"];
    }
    if (query.testID && !query.text) {
        return ["fiber", "accessibility"];
    }
    if (query.text) {
        const strategies: string[] = [];
        if (!isNonAscii(query.text)) {
            strategies.push("fiber");
        }
        strategies.push("accessibility", "ocr");
        return strategies;
    }
    return ["fiber", "accessibility", "ocr"];
}

export function convertPixelsToPoints(
    pixelX: number,
    pixelY: number,
    platform: "ios" | "android",
    devicePixelRatio: number,
    scaleFactor: number = 1
): { x: number; y: number } {
    const originalX = pixelX * scaleFactor;
    const originalY = pixelY * scaleFactor;
    if (platform === "android") {
        return { x: Math.round(originalX), y: Math.round(originalY) };
    }
    return {
        x: Math.round(originalX / devicePixelRatio),
        y: Math.round(originalY / devicePixelRatio),
    };
}

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
                if (!fiber || depth > 30) return null;
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
                if (!fiber || depth > 10) return null;
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
}): TapResult {
    return {
        success: true,
        ...data,
    };
}

export function formatTapFailure(data: {
    query: TapQuery;
    screen?: string | null;
    error?: string;
    attempted: TapAttempt[];
    suggestion: string;
    matches?: Array<{ index: number; component: string; text: string }>;
}): TapResult {
    const errorMsg = data.error || buildErrorMessage(data.query);
    return {
        success: false,
        query: data.query,
        screen: data.screen,
        error: errorMsg,
        attempted: data.attempted,
        suggestion: data.suggestion,
        matches: data.matches,
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

async function tryFiberStrategy(
    query: TapQuery,
    index?: number,
    maxTraversalDepth?: number
): Promise<StrategyResult> {
    try {
        const result = await pressElement({
            text: query.text,
            testID: query.testID,
            component: query.component,
            index,
            maxTraversalDepth,
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
                reason: parsed.error,
            };
            if (parsed.matches) {
                strategyResult.matches = parsed.matches;
            }
            return strategyResult;
        }

        // Input elements found via fiber can't be pressed — need native tap
        // Return as failure so orchestrator falls through to accessibility/coordinate
        if (parsed.needsNativeTap) {
            return {
                success: false,
                reason: `Found ${parsed.pressed} (input element) but it requires native tap — falling through to next strategy`,
            };
        }

        return {
            success: true,
            reason: "Pressed via React fiber tree",
            pressed: parsed.pressed,
            text: parsed.text,
            path: parsed.path || null,
            component: parsed.pressed || null,
        };
    } catch (err) {
        return {
            success: false,
            reason: `Fiber strategy error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

async function tryAccessibilityStrategy(
    query: TapQuery,
    index: number | undefined,
    platform: "ios" | "android"
): Promise<StrategyResult> {
    try {
        const hasTestID = !!query.testID;
        const hasText = !!query.text;

        if (!hasTestID && !hasText) {
            return { success: false, reason: "No text or testID for accessibility search" };
        }

        if (platform === "ios") {
            // iOS: IDB does not expose accessibilityIdentifier (testID),
            // so search by labelContains as best-effort fallback
            const searchText = query.text || query.testID;
            const result = await iosFindElement({
                labelContains: searchText,
                index,
            });

            if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                return { success: false, reason: result.error ?? "No iOS accessibility match" };
            }

            const match = result.allMatches[index ?? 0];
            if (!match) {
                return { success: false, reason: `Index ${index} out of bounds (${result.allMatches.length} matches)` };
            }

            await iosTap(match.center.x, match.center.y);

            return {
                success: true,
                reason: "Tapped via iOS accessibility",
                pressed: match.label || match.type,
                text: match.label || undefined,
                component: match.type || null,
                convertedTo: { x: match.center.x, y: match.center.y, unit: "points" },
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
            if (hasTestID && !hasText &&
                (!result.success || !result.allMatches || result.allMatches.length === 0)) {
                result = await androidFindElement({
                    contentDescContains: query.testID,
                    index,
                });
            }

            if (!result.success || !result.allMatches || result.allMatches.length === 0) {
                return { success: false, reason: result.error ?? "No Android accessibility match" };
            }

            const match = result.allMatches[index ?? 0];
            if (!match) {
                return { success: false, reason: `Index ${index} out of bounds (${result.allMatches.length} matches)` };
            }

            await androidTap(match.center.x, match.center.y);

            return {
                success: true,
                reason: "Tapped via Android accessibility",
                pressed: match.text || match.className || undefined,
                text: match.text || undefined,
                component: match.className || undefined,
                convertedTo: { x: match.center.x, y: match.center.y, unit: "pixels" },
            };
        }
    } catch (err) {
        return {
            success: false,
            reason: `Accessibility strategy error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

async function tryOcrStrategy(
    query: TapQuery,
    platform: "ios" | "android"
): Promise<StrategyResult> {
    try {
        const searchText = query.text;
        if (!searchText) {
            return { success: false, reason: "OCR strategy requires text query" };
        }

        let imageBuffer: Buffer;
        let scaleFactor = 1;
        let originalWidth: number | undefined;
        let originalHeight: number | undefined;

        if (platform === "ios") {
            const screenshot = await iosScreenshot();
            if (!screenshot.success || !screenshot.data) {
                return { success: false, reason: "Failed to capture iOS screenshot for OCR" };
            }
            imageBuffer = screenshot.data;
            scaleFactor = screenshot.scaleFactor ?? 1;
            originalWidth = screenshot.originalWidth;
            originalHeight = screenshot.originalHeight;
        } else {
            const { androidScreenshot } = await import("./android.js");
            const screenshot = await androidScreenshot();
            if (!screenshot.success || !screenshot.data) {
                return { success: false, reason: "Failed to capture Android screenshot for OCR" };
            }
            imageBuffer = screenshot.data;
            scaleFactor = screenshot.scaleFactor ?? 1;
            originalWidth = screenshot.originalWidth;
            originalHeight = screenshot.originalHeight;
        }

        const devicePixelRatio = (platform === "ios" && originalWidth && originalHeight)
            ? inferIOSDevicePixelRatio(originalWidth, originalHeight)
            : 3;

        const { recognizeText } = await import("./ocr.js");
        const ocrResult = await recognizeText(imageBuffer, {
            scaleFactor,
            platform,
            devicePixelRatio,
        });

        const lowerSearch = searchText.toLowerCase();
        const matchingWord = ocrResult.words.find(
            (w) => w.text.toLowerCase() === lowerSearch
        ) || ocrResult.words.find(
            (w) => w.text.toLowerCase().includes(lowerSearch)
        );

        if (!matchingWord) {
            return { success: false, reason: `OCR did not find text "${searchText}" on screen` };
        }

        if (platform === "ios") {
            await iosTap(matchingWord.tapCenter.x, matchingWord.tapCenter.y);
        } else {
            await androidTap(matchingWord.tapCenter.x, matchingWord.tapCenter.y);
        }

        return {
            success: true,
            reason: "Tapped via OCR text recognition",
            text: matchingWord.text,
            convertedTo: {
                x: matchingWord.tapCenter.x,
                y: matchingWord.tapCenter.y,
                unit: platform === "ios" ? "points" : "pixels",
            },
        };
    } catch (err) {
        return {
            success: false,
            reason: `OCR strategy error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

async function tryCoordinateStrategy(
    pixelX: number,
    pixelY: number,
    platform: "ios" | "android",
    lastScreenshot?: { originalWidth: number; originalHeight: number; scaleFactor: number }
): Promise<StrategyResult> {
    try {
        if (platform === "ios") {
            const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
            const originalWidth = lastScreenshot?.originalWidth;
            const originalHeight = lastScreenshot?.originalHeight;
            const devicePixelRatio = (originalWidth && originalHeight)
                ? inferIOSDevicePixelRatio(originalWidth, originalHeight)
                : 3;

            const converted = convertPixelsToPoints(pixelX, pixelY, "ios", devicePixelRatio, scaleFactor);
            await iosTap(converted.x, converted.y);

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
                convertedTo: { x: converted.x, y: converted.y, unit: "points" },
            };
        } else {
            const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
            const converted = convertPixelsToPoints(pixelX, pixelY, "android", 1, scaleFactor);
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
                convertedTo: { x: converted.x, y: converted.y, unit: "pixels" },
            };
        }
    } catch (err) {
        return {
            success: false,
            reason: `Coordinate strategy error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

// --- Orchestrator ---

export async function tap(options: TapOptions): Promise<TapResult> {
    const query = buildQuery(options);
    const strategy = options.strategy || "auto";
    const index = options.index;
    const maxTraversalDepth = options.maxTraversalDepth;

    // Validate inputs
    const hasSearchParam = query.text || query.testID || query.component;
    const hasCoordinates = query.x !== undefined || query.y !== undefined;

    if (!hasSearchParam && !hasCoordinates) {
        return {
            success: false,
            query,
            error: "Must provide at least one of: text, testID, component, or x/y coordinates",
        };
    }

    if (hasCoordinates && (query.x === undefined || query.y === undefined)) {
        return {
            success: false,
            query,
            error: "Both x and y coordinates must be provided",
        };
    }

    // Get connected app — auto-connect if none
    let apps = Array.from(connectedApps.values());
    if (apps.length === 0) {
        try {
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
            apps = Array.from(connectedApps.values());
        } catch {
            // Auto-connect failed, will fall through to error below
        }
    }

    if (apps.length === 0) {
        return {
            success: false,
            query,
            error: "No connected app. Auto-connect failed — no Metro servers found. Run scan_metro manually.",
        };
    }

    const app = apps[0];
    const platform = app.platform;

    // Determine strategies
    const strategies = getAvailableStrategies(query, strategy);
    const attempted: TapAttempt[] = [];

    // Execute strategies in order
    for (const strat of strategies) {
        let result: StrategyResult;

        switch (strat) {
            case "fiber":
                result = await tryFiberStrategy(query, index, maxTraversalDepth);
                break;
            case "accessibility":
                result = await tryAccessibilityStrategy(query, index, platform);
                break;
            case "ocr":
                result = await tryOcrStrategy(query, platform);
                break;
            case "coordinate":
                result = await tryCoordinateStrategy(
                    query.x!,
                    query.y!,
                    platform,
                    app.lastScreenshot
                );
                break;
            default:
                result = { success: false, reason: `Unknown strategy: ${strat}` };
        }

        if (result.success) {
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
            });
        }

        attempted.push({ strategy: strat, reason: result.reason });

        // If we got match suggestions from fiber, carry them forward
        if (result.matches) {
            return formatTapFailure({
                query,
                attempted,
                suggestion: `Found ${result.matches.length} match(es) — specify index to select one`,
                matches: result.matches,
            });
        }
    }

    // All strategies failed
    const suggestion = buildSuggestion(query, strategies, platform);
    return formatTapFailure({
        query,
        attempted,
        suggestion,
    });
}

function buildSuggestion(
    query: TapQuery,
    triedStrategies: string[],
    platform: string
): string {
    const suggestions: string[] = [];

    if (!triedStrategies.includes("ocr") && query.text) {
        suggestions.push("Try strategy='ocr' to find text visually on screen");
    }

    if (query.text && query.text.length <= 2) {
        suggestions.push(
            "Very short text is unreliable for OCR — use testID or coordinates instead"
        );
    }

    if (query.text && isNonAscii(query.text)) {
        suggestions.push("Non-ASCII text cannot use fiber strategy — use testID or coordinates instead");
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
