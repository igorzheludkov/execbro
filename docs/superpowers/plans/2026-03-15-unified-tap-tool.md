# Unified `tap` Tool Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 5 platform-specific tapping tools with a single unified `tap` MCP tool that auto-detects platform, handles coordinate conversion, and runs a fallback chain (fiber → accessibility → OCR → coordinates).

**Architecture:** New `src/core/tap.ts` orchestrator imports existing internal functions (`pressElement`, `iosTap`, `androidTap`, `iosFindElement`, `androidFindElement`, OCR). The `ConnectedApp` type gets `platform` and `lastScreenshot` fields. The MCP tool is registered via `registerToolWithTelemetry` in `src/index.ts`, replacing 5 removed tool registrations.

**Tech Stack:** TypeScript, MCP SDK (`server.registerTool`), CDP (Chrome DevTools Protocol), IDB (iOS), ADB (Android), EasyOCR

**Spec:** `docs/superpowers/specs/2026-03-15-unified-tap-tool-design.md`

---

## Chunk 1: Types and Platform Detection

### Task 1: Extend ConnectedApp type

**Files:**
- Modify: `src/core/types.ts:23-27`
- Test: `src/__tests__/unit/tap.test.ts` (create)

- [ ] **Step 1: Write the test for new type fields**

Create test file:

```typescript
// src/__tests__/unit/tap.test.ts
import { describe, it, expect } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";

describe("ConnectedApp type", () => {
    it("accepts platform and lastScreenshot fields", () => {
        const app: ConnectedApp = {
            ws: {} as any,
            deviceInfo: {
                id: "test",
                title: "Hermes React Native",
                description: "",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: "ws://localhost:8081",
                deviceName: "iPhone 16",
            },
            port: 8081,
            platform: "ios",
            lastScreenshot: {
                originalWidth: 1179,
                originalHeight: 2556,
                scaleFactor: 1,
            },
        };
        expect(app.platform).toBe("ios");
        expect(app.lastScreenshot?.originalWidth).toBe(1179);
    });

    it("allows lastScreenshot to be undefined", () => {
        const app: ConnectedApp = {
            ws: {} as any,
            deviceInfo: {
                id: "test",
                title: "Hermes React Native",
                description: "",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: "ws://localhost:8081",
                deviceName: "iPhone 16",
            },
            port: 8081,
            platform: "ios",
        };
        expect(app.lastScreenshot).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/__tests__/unit/tap.test.ts --no-coverage`
Expected: FAIL — `platform` and `lastScreenshot` don't exist on ConnectedApp type

- [ ] **Step 3: Add platform and lastScreenshot to ConnectedApp**

In `src/core/types.ts`, change the `ConnectedApp` interface (lines 23-27):

```typescript
export interface ConnectedApp {
    ws: WebSocket;
    deviceInfo: DeviceInfo;
    port: number;
    platform: "ios" | "android";
    lastScreenshot?: {
        originalWidth: number;
        originalHeight: number;
        scaleFactor: number;
    };
}
```

- [ ] **Step 4: Fix all TypeScript errors from the new required `platform` field**

Search for all places that construct a `ConnectedApp` object (in `src/core/connection.ts` where `connectedApps.set()` is called). Add `platform` field to each. The platform can be inferred from the connection context:
- In the connection flow, check if an iOS simulator was linked (`setActiveSimulatorUdid` is called) → `"ios"`
- Otherwise → `"android"`

Run: `npx tsc --noEmit` to find all type errors and fix them.

- [ ] **Step 5: Run test to verify it passes**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/__tests__/unit/tap.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/__tests__/unit/tap.test.ts src/core/connection.ts
git commit -m "feat(tap): extend ConnectedApp with platform and lastScreenshot fields"
```

### Task 2: Store screenshot metadata on ConnectedApp

**Files:**
- Modify: `src/index.ts` (ios_screenshot handler ~line 2825, android_screenshot handler ~line 2130)

- [ ] **Step 1: Update ios_screenshot handler to store metadata**

In `src/index.ts`, inside the `ios_screenshot` tool handler (around line 2858), after the screenshot is taken and `result.originalWidth`/`result.originalHeight` are available, store them on the connected app:

```typescript
// Store screenshot metadata for coordinate conversion
const firstApp = connectedApps.values().next().value;
if (firstApp) {
    firstApp.lastScreenshot = {
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        scaleFactor: result.scaleFactor || 1,
    };
}
```

- [ ] **Step 2: Update android_screenshot handler to store metadata**

In `src/index.ts`, inside the `android_screenshot` tool handler (around line 2165), after the screenshot result is available:

```typescript
// Store screenshot metadata for coordinate conversion
const firstApp = connectedApps.values().next().value;
if (firstApp) {
    firstApp.lastScreenshot = {
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        scaleFactor: result.scaleFactor || 1,
    };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(tap): store screenshot metadata on ConnectedApp for coordinate conversion"
```

---

## Chunk 2: Core tap orchestrator

### Task 3: Create tap.ts with types and helpers

**Files:**
- Create: `src/core/tap.ts`
- Test: `src/__tests__/unit/tap.test.ts` (extend)

- [ ] **Step 1: Write tests for tap types and helper functions**

Add to `src/__tests__/unit/tap.test.ts`:

```typescript
import {
    type TapQuery,
    type TapResult,
    type TapStrategy,
    buildQuery,
    getAvailableStrategies,
    isNonAscii,
    convertPixelsToPoints,
    getCurrentScreen,
    formatTapSuccess,
    formatTapFailure,
} from "../../core/tap.js";

describe("buildQuery", () => {
    it("builds query from text param", () => {
        const q = buildQuery({ text: "Submit" });
        expect(q).toEqual({ text: "Submit" });
    });

    it("builds query from coordinates", () => {
        const q = buildQuery({ x: 300, y: 600 });
        expect(q).toEqual({ x: 300, y: 600 });
    });

    it("builds query from multiple params", () => {
        const q = buildQuery({ text: "Submit", testID: "btn" });
        expect(q).toEqual({ text: "Submit", testID: "btn" });
    });
});

describe("isNonAscii", () => {
    it("returns false for ASCII text", () => {
        expect(isNonAscii("Submit")).toBe(false);
    });

    it("returns true for Cyrillic", () => {
        expect(isNonAscii("Отправить")).toBe(true);
    });

    it("returns true for emoji", () => {
        expect(isNonAscii("🔥")).toBe(true);
    });
});

describe("getAvailableStrategies", () => {
    it("returns all strategies for text query", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "auto")).toEqual([
            "fiber",
            "accessibility",
            "ocr",
        ]);
    });

    it("skips fiber for non-ASCII text", () => {
        expect(getAvailableStrategies({ text: "Отправить" }, "auto")).toEqual([
            "accessibility",
            "ocr",
        ]);
    });

    it("returns fiber+accessibility for testID", () => {
        expect(getAvailableStrategies({ testID: "btn" }, "auto")).toEqual([
            "fiber",
            "accessibility",
        ]);
    });

    it("returns only fiber for component", () => {
        expect(getAvailableStrategies({ component: "Button" }, "auto")).toEqual([
            "fiber",
        ]);
    });

    it("returns coordinate for x,y", () => {
        expect(getAvailableStrategies({ x: 100, y: 200 }, "auto")).toEqual([
            "coordinate",
        ]);
    });

    it("returns single strategy when explicitly set", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "ocr")).toEqual([
            "ocr",
        ]);
    });
});

describe("convertPixelsToPoints", () => {
    it("divides by pixel ratio for iOS", () => {
        const result = convertPixelsToPoints(300, 600, "ios", 3);
        expect(result).toEqual({ x: 100, y: 200 });
    });

    it("passes through for Android", () => {
        const result = convertPixelsToPoints(300, 600, "android", 3);
        expect(result).toEqual({ x: 300, y: 600 });
    });

    it("applies scaleFactor before conversion", () => {
        const result = convertPixelsToPoints(150, 300, "ios", 3, 2);
        // 150*2=300/3=100, 300*2=600/3=200
        expect(result).toEqual({ x: 100, y: 200 });
    });

    it("rounds to integers", () => {
        const result = convertPixelsToPoints(301, 599, "ios", 3);
        expect(result).toEqual({ x: 100, y: 200 });
    });
});

describe("formatTapSuccess", () => {
    it("returns minimal success response", () => {
        const result = formatTapSuccess({
            method: "fiber",
            query: { text: "Submit" },
            pressed: "PrimaryButton",
            text: "Submit",
            screen: "LoginScreen",
            path: "LoginScreen > Form > PrimaryButton",
        });
        expect(result.success).toBe(true);
        expect(result.method).toBe("fiber");
        expect(result.query).toEqual({ text: "Submit" });
    });
});

describe("formatTapFailure", () => {
    it("includes attempted strategies and suggestion", () => {
        const result = formatTapFailure({
            query: { text: "hamburger" },
            screen: "HomeScreen",
            attempted: [
                { strategy: "fiber", reason: "No match" },
            ],
            suggestion: "Use screenshot",
        });
        expect(result.success).toBe(false);
        expect(result.attempted).toHaveLength(1);
        expect(result.suggestion).toBe("Use screenshot");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/__tests__/unit/tap.test.ts --no-coverage`
Expected: FAIL — module `../../core/tap.js` not found

- [ ] **Step 3: Implement tap.ts types and helpers**

Create `src/core/tap.ts`:

```typescript
import { connectedApps } from "./state.js";
import { inferIOSDevicePixelRatio } from "./ocr.js";
import { executeInApp } from "./executor.js";
import { pressElement } from "./executor.js";
import { iosTap, iosFindElement, iosScreenshot } from "./ios.js";
import { androidTap, androidFindElement } from "./android.js";

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
    // Coordinate query — always direct tap
    if (query.x !== undefined && query.y !== undefined) {
        return ["coordinate"];
    }

    // Explicit strategy — return just that one
    if (strategy !== "auto") {
        return [strategy];
    }

    // Component only — fiber is the only option
    if (query.component && !query.text && !query.testID) {
        return ["fiber"];
    }

    // testID — fiber + accessibility
    if (query.testID && !query.text) {
        return ["fiber", "accessibility"];
    }

    // text — full chain, skip fiber for non-ASCII
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
    // Restore original pixel coordinates if screenshot was scaled
    const originalX = pixelX * scaleFactor;
    const originalY = pixelY * scaleFactor;

    if (platform === "android") {
        return { x: Math.round(originalX), y: Math.round(originalY) };
    }

    // iOS: convert pixels to points
    return {
        x: Math.round(originalX / devicePixelRatio),
        y: Math.round(originalY / devicePixelRatio),
    };
}

export async function getCurrentScreen(): Promise<string | null> {
    // Placeholder — will be implemented via fiber tree traversal in Task 7
    return null;
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
    const errorMsg =
        data.error ||
        buildErrorMessage(data.query);

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/__tests__/unit/tap.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tap.ts src/__tests__/unit/tap.test.ts
git commit -m "feat(tap): add tap types and helper functions"
```

### Task 4: Implement the tap orchestrator function

**Files:**
- Modify: `src/core/tap.ts`
- Test: `src/__tests__/unit/tap.test.ts` (extend)

- [ ] **Step 1: Write integration-style test for the tap orchestrator**

Add to `src/__tests__/unit/tap.test.ts`:

```typescript
import { tap } from "../../core/tap.js";
import * as state from "../../core/state.js";

describe("tap orchestrator", () => {
    it("returns error when no app is connected", async () => {
        // Ensure no apps connected
        state.connectedApps.clear();
        const result = await tap({ text: "Submit" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("No connected app");
    });

    it("validates that at least one search param is provided", async () => {
        const result = await tap({});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Must provide");
    });

    it("validates x and y are both provided for coordinate tap", async () => {
        const result = await tap({ x: 100 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Both x and y");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/__tests__/unit/tap.test.ts --no-coverage`
Expected: FAIL — `tap` not exported

- [ ] **Step 3: Implement the tap orchestrator**

Add to `src/core/tap.ts` (imports already added in Task 3):

```typescript
export async function tap(options: TapOptions): Promise<TapResult> {
    const query = buildQuery(options);
    const index = options.index ?? 0;

    // Validation
    const hasSearchParam = query.text || query.testID || query.component;
    const hasCoordinates = query.x !== undefined && query.y !== undefined;

    if (!hasSearchParam && !hasCoordinates) {
        return {
            success: false,
            query,
            error: "Must provide at least one of text/testID/component, or both x and y coordinates.",
            attempted: [],
            suggestion: "Example: tap(text=\"Submit\") or tap(x=300, y=600)",
        };
    }

    if ((query.x !== undefined) !== (query.y !== undefined)) {
        return {
            success: false,
            query,
            error: "Both x and y coordinates must be provided together.",
            attempted: [],
            suggestion: "Provide both x and y: tap(x=300, y=600)",
        };
    }

    // Get connected app and platform
    const app = connectedApps.values().next().value;
    if (!app) {
        return {
            success: false,
            query,
            error: "No connected app. Use `connect_metro` first.",
            attempted: [],
            suggestion: "Call `connect_metro` to connect to a running React Native app.",
        };
    }

    const platform = app.platform;
    const strategy = options.strategy ?? "auto";
    const strategies = getAvailableStrategies(query, strategy);
    const attempted: TapAttempt[] = [];
    const screen = await getCurrentScreen();

    // Execute strategies in order
    for (const strat of strategies) {
        switch (strat) {
            case "fiber": {
                const result = await tryFiberStrategy(query, index);
                if (result.success) {
                    return formatTapSuccess({
                        method: "fiber",
                        query,
                        pressed: result.pressed,
                        text: result.text,
                        screen: result.screen ?? screen,
                        path: result.path,
                    });
                }
                attempted.push({ strategy: "fiber", reason: result.reason });
                if (result.matches) {
                    // Index out of bounds — return immediately with matches
                    return formatTapFailure({
                        query,
                        screen,
                        error: result.reason,
                        attempted,
                        suggestion: `Use index 0-${result.matches.length - 1} to select a match.`,
                        matches: result.matches,
                    });
                }
                break;
            }

            case "accessibility": {
                const result = await tryAccessibilityStrategy(query, index, platform);
                if (result.success) {
                    return formatTapSuccess({
                        method: "accessibility",
                        query,
                        pressed: result.pressed,
                        text: result.text,
                        screen: screen,
                        path: result.path,
                    });
                }
                attempted.push({ strategy: "accessibility", reason: result.reason });
                break;
            }

            case "ocr": {
                const result = await tryOcrStrategy(query, platform);
                if (result.success) {
                    return formatTapSuccess({
                        method: "ocr",
                        query,
                        text: result.text,
                        screen: screen,
                        path: null,
                    });
                }
                attempted.push({ strategy: "ocr", reason: result.reason });
                break;
            }

            case "coordinate": {
                const result = await tryCoordinateStrategy(
                    query.x!,
                    query.y!,
                    platform,
                    app.lastScreenshot
                );
                if (result.success) {
                    return formatTapSuccess({
                        method: "coordinate",
                        query,
                        tappedAt: { x: query.x!, y: query.y! },
                        convertedTo: result.convertedTo,
                        platform,
                        screen: result.screen,
                        component: result.component,
                        path: result.path,
                    });
                }
                attempted.push({ strategy: "coordinate", reason: result.reason });
                break;
            }
        }
    }

    // All strategies failed
    const suggestion = hasCoordinates
        ? "Verify the coordinates are correct and an app is connected."
        : "Use `screenshot` to capture the screen, visually identify the element's position, then call `tap(x=<pixel_x>, y=<pixel_y>)` with pixel coordinates from the screenshot.";

    // Component-only gets a more specific suggestion
    const componentOnlySuggestion = query.component && !query.text && !query.testID
        ? `Component matching only works via fiber tree. Try tap(text=...) for broader matching, or use \`screenshot\` to identify coordinates and call tap(x=<pixel_x>, y=<pixel_y>).`
        : suggestion;

    return formatTapFailure({
        query,
        screen,
        attempted,
        suggestion: componentOnlySuggestion,
    });
}
```

- [ ] **Step 4: Implement strategy functions (stubs for now, real logic in Task 5)**

Add to `src/core/tap.ts`:

```typescript
// --- Strategy implementations ---

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

async function tryFiberStrategy(
    query: TapQuery,
    index: number
): Promise<StrategyResult> {
    try {
        const result = await pressElement({
            text: query.text,
            testID: query.testID,
            component: query.component,
            index,
        });

        if (!result.success) {
            // Parse the error to extract useful info
            const parsed = result.result ? tryParseJson(result.result) : null;
            if (parsed?.matches) {
                return {
                    success: false,
                    reason: parsed.error || result.error || "No match found",
                    matches: parsed.matches,
                };
            }
            return {
                success: false,
                reason: result.error || parsed?.error || "No pressable element found",
            };
        }

        const parsed = result.result ? tryParseJson(result.result) : null;
        return {
            success: true,
            reason: "",
            pressed: parsed?.pressed || undefined,
            text: parsed?.text || undefined,
            path: parsed?.path || undefined,
            screen: null, // Will be extracted from path
        };
    } catch (error) {
        return {
            success: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

async function tryAccessibilityStrategy(
    query: TapQuery,
    index: number,
    platform: "ios" | "android"
): Promise<StrategyResult> {
    try {
        // Note: testID maps to accessibilityIdentifier on iOS, but iosFindElement
        // only searches by label/value — so testID queries search by label as fallback.
        // On Android, testID doesn't map to accessibility properties reliably.
        const searchText = query.text || query.testID;
        if (!searchText) {
            return {
                success: false,
                reason: "Accessibility strategy requires text or testID",
            };
        }

        if (platform === "ios") {
            const result = await iosFindElement({
                labelContains: searchText,
            });
            if (!result.success || !result.allMatches?.length) {
                return {
                    success: false,
                    reason: `No element with label containing "${searchText}" found in accessibility tree`,
                };
            }
            const element = result.allMatches[index];
            if (!element) {
                return {
                    success: false,
                    reason: `Found ${result.allMatches.length} elements but index ${index} requested`,
                };
            }
            // Tap at element center (already in points from IDB)
            await iosTap(element.center.x, element.center.y);
            return {
                success: true,
                reason: "",
                pressed: element.label || element.type,
                text: element.label,
            };
        } else {
            const result = await androidFindElement({
                textContains: searchText,
            });
            if (!result.success || !result.allMatches?.length) {
                return {
                    success: false,
                    reason: `No element with text containing "${searchText}" found in accessibility tree`,
                };
            }
            const element = result.allMatches[index];
            if (!element) {
                return {
                    success: false,
                    reason: `Found ${result.allMatches.length} elements but index ${index} requested`,
                };
            }
            await androidTap(element.center.x, element.center.y);
            return {
                success: true,
                reason: "",
                pressed: element.text || element.type,
                text: element.text,
            };
        }
    } catch (error) {
        return {
            success: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

async function tryOcrStrategy(
    query: TapQuery,
    platform: "ios" | "android"
): Promise<StrategyResult> {
    try {
        // 1. Take a fresh screenshot
        let imageBuffer: Buffer;
        let scaleFactor = 1;
        let devicePixelRatio = 3;

        if (platform === "ios") {
            const ssResult = await iosScreenshot();
            if (!ssResult.success || !ssResult.data) {
                return { success: false, reason: "Failed to take iOS screenshot for OCR" };
            }
            imageBuffer = ssResult.data;
            scaleFactor = ssResult.scaleFactor || 1;
            if (ssResult.originalWidth && ssResult.originalHeight) {
                devicePixelRatio = inferIOSDevicePixelRatio(
                    ssResult.originalWidth, ssResult.originalHeight
                );
            }
        } else {
            const { androidScreenshot } = await import("./android.js");
            const ssResult = await androidScreenshot();
            if (!ssResult.success || !ssResult.data) {
                return { success: false, reason: "Failed to take Android screenshot for OCR" };
            }
            imageBuffer = ssResult.data;
            scaleFactor = ssResult.scaleFactor || 1;
            devicePixelRatio = 1; // Android uses raw pixels
        }

        // 2. Run OCR using recognizeText (not raw HTTP)
        const { recognizeText } = await import("./ocr.js");
        const ocrResult = await recognizeText(imageBuffer, {
            scaleFactor,
            platform,
            devicePixelRatio,
        });

        if (!ocrResult.words?.length) {
            return { success: false, reason: "OCR found no text on screen" };
        }

        // 3. Search for matching text (case-insensitive substring)
        const searchText = query.text!.toLowerCase();
        const match = ocrResult.words.find(
            (w) => w.text.toLowerCase().includes(searchText)
        );

        if (!match) {
            return {
                success: false,
                reason: `Text "${query.text}" not recognized in screenshot`,
            };
        }

        // 4. tapCenter coordinates are already converted for the platform
        if (platform === "ios") {
            await iosTap(match.tapCenter.x, match.tapCenter.y);
        } else {
            await androidTap(match.tapCenter.x, match.tapCenter.y);
        }

        return {
            success: true,
            reason: "",
            text: match.text,
        };
    } catch (error) {
        return {
            success: false,
            reason: error instanceof Error ? error.message : String(error),
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
        const scaleFactor = lastScreenshot?.scaleFactor ?? 1;
        let devicePixelRatio = 3; // default for modern iPhones

        if (platform === "ios") {
            if (lastScreenshot) {
                devicePixelRatio = inferIOSDevicePixelRatio(
                    lastScreenshot.originalWidth,
                    lastScreenshot.originalHeight
                );
            } else {
                // Take quick screenshot to get dimensions
                try {
                    const ssResult = await iosScreenshot();
                    if (ssResult.success && ssResult.originalWidth && ssResult.originalHeight) {
                        devicePixelRatio = inferIOSDevicePixelRatio(
                            ssResult.originalWidth,
                            ssResult.originalHeight
                        );
                    }
                } catch {
                    // Fall back to default ratio
                }
            }
        }

        const converted = convertPixelsToPoints(
            pixelX,
            pixelY,
            platform,
            devicePixelRatio,
            scaleFactor
        );

        if (platform === "ios") {
            await iosTap(converted.x, converted.y);
        } else {
            await androidTap(converted.x, converted.y);
        }

        // Best-effort: identify what was tapped
        let screen: string | null = null;
        let component: string | null = null;
        let path: string | null = null;

        // inspect_at_point is best-effort, don't fail the tap if it errors
        // This will be connected in Task 5

        return {
            success: true,
            reason: "",
            screen,
            component,
            path,
            convertedTo: {
                x: converted.x,
                y: converted.y,
                unit: platform === "ios" ? "points" : "pixels",
            },
        };
    } catch (error) {
        return {
            success: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

function tryParseJson(str: string): any {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest src/__tests__/unit/tap.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (fix any import issues)

- [ ] **Step 7: Commit**

```bash
git add src/core/tap.ts src/__tests__/unit/tap.test.ts
git commit -m "feat(tap): implement tap orchestrator with fallback chain"
```

---

## Chunk 3: MCP tool registration and tool removal

### Task 5: Register the `tap` MCP tool

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add tap tool import**

At the top of `src/index.ts`, add:

```typescript
import { tap, type TapResult } from "./core/tap.js";
```

- [ ] **Step 2: Register the tap tool**

Add the tool registration after the existing tool registrations (near the end of the tool registration section). Use `registerToolWithTelemetry`:

```typescript
registerToolWithTelemetry(
    "tap",
    {
        description:
            "Tap a UI element. Automatically tries multiple strategies: fiber tree (React), accessibility tree (native), and OCR (visual). " +
            "Auto-detects platform (iOS/Android). For coordinates, accepts pixels from screenshot and converts internally.\n\n" +
            "Examples:\n" +
            "- tap(text=\"Submit\") — finds and taps element with matching text\n" +
            "- tap(testID=\"login-btn\") — finds by testID\n" +
            "- tap(component=\"HamburgerIcon\") — finds by React component name\n" +
            "- tap(x=300, y=600) — taps at pixel coordinates from screenshot\n" +
            "- tap(text=\"Menu\", strategy=\"ocr\") — forces OCR strategy only",
        inputSchema: {
            type: "object" as const,
            properties: {
                text: {
                    type: "string",
                    description:
                        "Visible text to match (case-insensitive substring). ASCII only for fiber strategy; OCR handles non-ASCII.",
                },
                testID: {
                    type: "string",
                    description: "Exact match on the element's testID prop.",
                },
                component: {
                    type: "string",
                    description:
                        "Component name match (case-insensitive substring, e.g. 'Button', 'MenuItem').",
                },
                index: {
                    type: "number",
                    description:
                        "Zero-based index when multiple elements match (default: 0).",
                },
                x: {
                    type: "number",
                    description:
                        "X coordinate in pixels (from screenshot). Must provide both x and y.",
                },
                y: {
                    type: "number",
                    description:
                        "Y coordinate in pixels (from screenshot). Must provide both x and y.",
                },
                strategy: {
                    type: "string",
                    enum: ["auto", "fiber", "accessibility", "ocr", "coordinate"],
                    description:
                        'Strategy to use. "auto" (default) tries fiber → accessibility → OCR. ' +
                        'Set explicitly to skip strategies you know will fail.',
                },
            },
        },
    },
    async (args) => {
        const result: TapResult = await tap({
            text: args.text,
            testID: args.testID,
            component: args.component,
            index: args.index,
            x: args.x,
            y: args.y,
            strategy: args.strategy,
        });

        const text = JSON.stringify(result, null, 2);
        return {
            content: [{ type: "text", text }],
            isError: !result.success,
        };
    }
);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(tap): register unified tap MCP tool"
```

### Task 6: Remove old tool registrations

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Remove ios_tap tool registration**

Search `src/index.ts` for `"ios_tap"` tool registration (the `server.registerTool("ios_tap", ...)` block). Delete the entire registration block including the closing `);`.

- [ ] **Step 2: Remove ios_tap_element tool registration**

Search `src/index.ts` for `"ios_tap_element"` tool registration. Delete the entire block.

- [ ] **Step 3: Remove android_tap tool registration**

Search `src/index.ts` for `"android_tap"` tool registration (the `registerToolWithTelemetry("android_tap", ...)` block). Delete the entire block.

- [ ] **Step 4: Remove android_tap_element tool registration**

Search `src/index.ts` for `"android_tap_element"` tool registration. Delete the entire block.

- [ ] **Step 5: Remove press_element tool registration**

Search `src/index.ts` for `"press_element"` tool registration (the `registerToolWithTelemetry("press_element", ...)` block). Delete the entire block.

- [ ] **Step 5.5: Update server.instructions string**

Search `src/index.ts` for the `instructions:` field on the MCP server initialization. Update it to mention `tap` instead of `press_element`, `ios_tap`, or `android_tap`.

- [ ] **Step 6: Verify TypeScript compiles and no dangling references**

Run: `npx tsc --noEmit`
Expected: No errors. If there are unused imports, remove them.

- [ ] **Step 7: Run all unit tests**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest --no-coverage src/__tests__/unit/`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat(tap): remove ios_tap, android_tap, ios_tap_element, android_tap_element, press_element tool registrations"
```

---

## Chunk 4: Screen identifier and inspect-after-tap

### Task 7: Implement getCurrentScreen via fiber tree

**Files:**
- Modify: `src/core/tap.ts`

- [ ] **Step 1: Implement getCurrentScreen using executeInApp**

Replace the placeholder `getCurrentScreen()` in `src/core/tap.ts` with a real implementation that walks the React fiber tree to find the current screen name.

**Note:** The evaluated JS expression uses `var` instead of `let`/`const` because Hermes engine's `Runtime.evaluate` sometimes has issues with block-scoped declarations:

```typescript
import { executeInApp } from "./executor.js";

export async function getCurrentScreen(): Promise<string | null> {
    try {
        const expression = `(function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return null;
            var renderers = hook.getFiberRoots ? null : null;
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

                // Check for RNSScreen (React Navigation)
                if (name === 'RNSScreen') {
                    var props = fiber.memoizedProps || {};
                    if (props['aria-hidden'] === true) return null;
                    // Find the first user component child
                    var child = fiber.child;
                    while (child) {
                        var childName = child.type && (child.type.displayName || child.type.name);
                        if (childName && typeof child.type !== 'string' && childName !== 'RNSScreenContentWrapper') {
                            return childName;
                        }
                        child = child.child;
                    }
                }

                // Recurse children
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

            // Fallback: first user-defined component
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/core/tap.ts
git commit -m "feat(tap): implement getCurrentScreen via fiber tree traversal"
```

### Task 8: Add best-effort inspect after coordinate tap

**Files:**
- Modify: `src/core/tap.ts`

- [ ] **Step 1: Add post-tap inspection to tryCoordinateStrategy**

In `tryCoordinateStrategy`, after the tap succeeds, add a best-effort call to identify what was tapped. Replace the placeholder comment block with:

```typescript
// Best-effort: identify what was tapped via fiber tree inspection
try {
    const inspectExpr = `(function() {
        var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return null;
        // Use a simplified hit-test at the tapped coordinates
        // This is best-effort — failure doesn't affect tap success
        return null;
    })()`;
    // For now, just get the current screen
    screen = await getCurrentScreen();
} catch {
    // Inspection failure is non-fatal
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/core/tap.ts
git commit -m "feat(tap): add best-effort screen identification after coordinate tap"
```

---

## Chunk 5: Documentation updates

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update MCP Tools Exposed section**

In `CLAUDE.md`, update the MCP Tools Exposed list:
- Remove: `press_element`
- Add: `tap` — Unified tool to tap UI elements. Auto-detects platform, tries fiber tree → accessibility → OCR → coordinates. Accepts text, testID, component name, or pixel coordinates.

- [ ] **Step 2: Rewrite UI Interaction section**

Replace the "UI Interaction — Preferred Method" section with:

```markdown
- **UI Interaction — Preferred Method**: Use the unified `tap` tool for all tapping:
    1. `tap(text="Submit")` — matches visible text, tries fiber tree → accessibility → OCR automatically
    2. `tap(testID="menu-btn")` — matches by testID prop
    3. `tap(component="HamburgerIcon")` — matches by React component name (fiber tree only)
    4. `tap(x=300, y=600)` — taps at pixel coordinates from screenshot (auto-converts to points)
    5. Use `strategy` param to skip strategies you know will fail: `tap(text="≡", strategy="ocr")`
    6. On failure, follow the `suggestion` field in the response — it tells you exactly what to try next
```

- [ ] **Step 3: Remove old tool references**

Remove references to `ios_tap`, `android_tap`, `ios_tap_element`, `android_tap_element` from the "UI Interaction" and "Icon-only buttons" sections. Replace with `tap` equivalents.

- [ ] **Step 4: Update Non-ASCII text section**

Replace the non-ASCII text guidance with:
```markdown
- **Non-ASCII text** (Cyrillic, CJK, Arabic, etc.): `tap(text="текст")` automatically skips fiber (Hermes limitation) and uses accessibility/OCR. For best results, use `testID` or `component` params instead.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for unified tap tool"
```

### Task 10: Update get_usage_guide tool

**Files:**
- Modify: `src/index.ts` (the `get_usage_guide` tool handler text)

- [ ] **Step 1: Find and update usage guide references**

Search for `press_element`, `ios_tap`, `android_tap` in the `get_usage_guide` tool handler text and update to reference the unified `tap` tool instead.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "docs: update get_usage_guide for unified tap tool"
```

---

## Chunk 6: Build and manual verification

### Task 11: Build and verify

**Files:**
- None (verification only)

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Successful compilation

- [ ] **Step 2: Run all unit tests**

Run: `NODE_OPTIONS='--experimental-vm-modules' npx jest --no-coverage src/__tests__/unit/`
Expected: All PASS

- [ ] **Step 3: Verify tap tool appears in MCP tool list**

Run: `npm start` and check that the `tap` tool is registered and the removed tools (`ios_tap`, `android_tap`, `ios_tap_element`, `android_tap_element`, `press_element`) are NOT registered.

- [ ] **Step 4: Verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Final commit with version bump (if needed)**

If all checks pass, the implementation is complete.
