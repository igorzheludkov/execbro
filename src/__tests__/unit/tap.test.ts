// src/__tests__/unit/tap.test.ts
import { describe, it, expect } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import {
    type TapQuery,
    type TapResult,
    type TapStrategy,
    type TapScreenshot,
    type TapVerification,
    buildQuery,
    getAvailableStrategies,
    hasProblematicUnicode,
    convertPixelsToPoints,
    formatTapSuccess,
    formatTapFailure,
    buildVerificationExplanation,
} from "../../pro/tap.js";

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

describe("hasProblematicUnicode", () => {
    it("returns false for ASCII text", () => {
        expect(hasProblematicUnicode("Submit")).toBe(false);
    });
    it("returns false for Polish accented text", () => {
        expect(hasProblematicUnicode("Potwierdź")).toBe(false);
    });
    it("returns false for Vietnamese accented text", () => {
        expect(hasProblematicUnicode("Tin nhắn")).toBe(false);
    });
    it("returns false for German umlauts", () => {
        expect(hasProblematicUnicode("Übersicht")).toBe(false);
    });
    it("returns false for French accented text", () => {
        expect(hasProblematicUnicode("Paramètres")).toBe(false);
    });
    it("returns false for Cyrillic text", () => {
        expect(hasProblematicUnicode("Отправить")).toBe(false);
    });
    it("returns false for Chinese text", () => {
        expect(hasProblematicUnicode("提交")).toBe(false);
    });
    it("returns false for Japanese text", () => {
        expect(hasProblematicUnicode("送信")).toBe(false);
    });
    it("returns true for emoji", () => {
        expect(hasProblematicUnicode("🔥")).toBe(true);
    });
    it("returns true for mixed text with emoji", () => {
        expect(hasProblematicUnicode("Save 🔥")).toBe(true);
    });
    it("returns true for flag emoji", () => {
        expect(hasProblematicUnicode("🇺🇸")).toBe(true);
    });
    it("returns true for zero-width joiner sequences", () => {
        expect(hasProblematicUnicode("👨‍👩‍👧")).toBe(true);
    });
    it("returns true for weather symbols", () => {
        expect(hasProblematicUnicode("☀")).toBe(true);
    });
});

describe("getAvailableStrategies", () => {
    it("returns accessibility-first for text query", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "auto")).toEqual(["accessibility", "fiber", "ocr"]);
    });
    it("includes fiber for non-ASCII accented text", () => {
        expect(getAvailableStrategies({ text: "Отправить" }, "auto")).toEqual(["accessibility", "fiber", "ocr"]);
    });
    it("includes fiber for Polish text", () => {
        expect(getAvailableStrategies({ text: "Potwierdź" }, "auto")).toEqual(["accessibility", "fiber", "ocr"]);
    });
    it("includes fiber for Vietnamese text", () => {
        expect(getAvailableStrategies({ text: "Tin nhắn" }, "auto")).toEqual(["accessibility", "fiber", "ocr"]);
    });
    it("skips fiber for emoji text", () => {
        expect(getAvailableStrategies({ text: "🔥 Fire" }, "auto")).toEqual(["accessibility", "ocr"]);
    });
    it("returns accessibility+fiber for testID", () => {
        expect(getAvailableStrategies({ testID: "btn" }, "auto")).toEqual(["accessibility", "fiber"]);
    });
    it("returns only fiber for component", () => {
        expect(getAvailableStrategies({ component: "Button" }, "auto")).toEqual(["fiber"]);
    });
    it("returns coordinate for x,y", () => {
        expect(getAvailableStrategies({ x: 100, y: 200 }, "auto")).toEqual(["coordinate"]);
    });
    it("returns explicit strategy with OCR fallback for text query", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "fiber")).toEqual(["fiber", "ocr"]);
        expect(getAvailableStrategies({ text: "Submit" }, "accessibility")).toEqual(["accessibility", "ocr"]);
    });
    it("returns only OCR when explicitly set with text query", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "ocr")).toEqual(["ocr"]);
    });
    it("returns single strategy when explicitly set without text", () => {
        expect(getAvailableStrategies({ testID: "btn" }, "fiber")).toEqual(["fiber"]);
    });
});

describe("convertPixelsToPoints", () => {
    it("divides by pixel ratio for iOS", () => {
        expect(convertPixelsToPoints(300, 600, "ios", 3)).toEqual({ x: 100, y: 200 });
    });
    it("passes through for Android", () => {
        expect(convertPixelsToPoints(300, 600, "android", 3)).toEqual({ x: 300, y: 600 });
    });
    it("applies scaleFactor before conversion", () => {
        expect(convertPixelsToPoints(150, 300, "ios", 3, 2)).toEqual({ x: 100, y: 200 });
    });
    it("rounds to integers", () => {
        expect(convertPixelsToPoints(301, 599, "ios", 3)).toEqual({ x: 100, y: 200 });
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
            attempted: [{ strategy: "fiber", reason: "No match" }],
            suggestion: "Use screenshot",
        });
        expect(result.success).toBe(false);
        expect(result.attempted).toHaveLength(1);
        expect(result.suggestion).toBe("Use screenshot");
    });
});

describe("formatTapSuccess with screenshot and verification", () => {
    it("includes screenshot field when provided", () => {
        const result = formatTapSuccess({
            method: "fiber",
            query: { text: "Submit" },
            pressed: "Button",
            screenshot: {
                image: "data:image/jpeg;base64,abc123",
                width: 1170,
                height: 2532,
                scaleFactor: 1.0,
            },
        });
        expect(result.success).toBe(true);
        expect(result.screenshot).toEqual({
            image: "data:image/jpeg;base64,abc123",
            width: 1170,
            height: 2532,
            scaleFactor: 1.0,
        });
    });

    it("includes verification field when provided", () => {
        const result = formatTapSuccess({
            method: "coordinate",
            query: { x: 300, y: 600 },
            verification: {
                meaningful: true,
                changeRate: 0.12,
                changedPixels: 48210,
                totalPixels: 2961720,
                explanation: "Tap caused a visible UI change (12.0% pixel diff). The screen updated as expected.",
            },
            screenshot: {
                image: "data:image/jpeg;base64,abc123",
                width: 1170,
                height: 2532,
                scaleFactor: 1.0,
            },
        });
        expect(result.verification).toEqual({
            meaningful: true,
            changeRate: 0.12,
            changedPixels: 48210,
            totalPixels: 2961720,
            explanation: "Tap caused a visible UI change (12.0% pixel diff). The screen updated as expected.",
        });
        expect(result.screenshot).toBeDefined();
    });

    it("omits screenshot and verification when not provided", () => {
        const result = formatTapSuccess({
            method: "fiber",
            query: { text: "Submit" },
        });
        expect(result.screenshot).toBeUndefined();
        expect(result.verification).toBeUndefined();
    });
});

describe("formatTapFailure with timeout error", () => {
    it("includes error field when timeout info is provided", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [
                { strategy: "fiber", reason: "fiber timed out after 5000ms" },
                { strategy: "accessibility", reason: "accessibility timed out after 3500ms" },
                { strategy: "ocr", reason: "Skipped — only 200ms remaining (budget 20000ms)" },
            ],
            error: "Tap timed out after 20000ms (budget 20000ms)",
            suggestion: "Use screenshot and retry",
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("timed out");
        expect(result.attempted).toHaveLength(3);
        expect(result.attempted![0].reason).toContain("timed out after 5000ms");
        expect(result.attempted![2].reason).toContain("Skipped");
    });

    it("uses default error message when no explicit error field", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [{ strategy: "fiber", reason: "No match" }],
            suggestion: "Try OCR",
        });
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        // Default error from buildErrorMessage, not timeout
        expect(result.error).not.toContain("timed out");
    });
});

describe("formatTapFailure with screenshot and verification", () => {
    it("includes warning when verification shows not meaningful", () => {
        const result = formatTapFailure({
            query: { x: 300, y: 600 },
            attempted: [{ strategy: "coordinate", reason: "executed" }],
            suggestion: "Retry with adjusted coordinates",
            verification: {
                meaningful: false,
                changeRate: 0.001,
                changedPixels: 312,
                totalPixels: 2961720,
                explanation: "No visual change detected between before and after screenshots. The element may not respond visually or the tap may have missed.",
            },
            screenshot: {
                image: "data:image/jpeg;base64,abc123",
                width: 1170,
                height: 2532,
                scaleFactor: 1.0,
            },
        });
        expect(result.verification?.meaningful).toBe(false);
        expect(result.screenshot).toBeDefined();
        expect(result.warning).toContain("no visual change detected");
    });
});

describe("buildVerificationExplanation", () => {
    it("explains persistent visual change", () => {
        const explanation = buildVerificationExplanation({
            meaningful: true, changeRate: 0.032, changedPixels: 32000, totalPixels: 1000000,
        });
        expect(explanation).toContain("visible UI change");
        expect(explanation).toContain("3.2%");
    });

    it("explains transient change from burst", () => {
        const explanation = buildVerificationExplanation({
            meaningful: true, changeRate: 0.001, changedPixels: 1000, totalPixels: 1000000,
            transientChangeDetected: true, peakChangeRate: 0.041, peakFrame: 2,
        });
        expect(explanation).toContain("transient visual feedback");
        expect(explanation).toContain("frame 2");
        expect(explanation).toContain("4.1%");
    });

    it("explains no change in standard mode", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false, changeRate: 0.0, changedPixels: 0, totalPixels: 1000000,
        });
        expect(explanation).toContain("No visual change");
        expect(explanation).toContain("before and after");
    });

    it("explains no change in burst mode", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false, changeRate: 0.0, changedPixels: 0, totalPixels: 1000000,
            transientChangeDetected: false, peakChangeRate: 0.001, peakFrame: 0,
        });
        expect(explanation).toContain("No visual change");
        expect(explanation).toContain("burst frames");
    });
});

describe("getIOSDevicePixelRatio", () => {
    it("calculates DPR from screenshot width and accessibility root frame", async () => {
        const { calculateDPR } = await import("../../core/ios.js");
        // iPhone 3x: 1260px screenshot, 420pt root frame width
        expect(calculateDPR(1260, 420)).toBe(3);
        // iPad 2x: 2048px screenshot, 1024pt root frame width
        expect(calculateDPR(2048, 1024)).toBe(2);
        // iPhone SE 2x: 750px screenshot, 375pt root frame width
        expect(calculateDPR(750, 375)).toBe(2);
    });
});

describe("tap orchestrator", () => {
    it("returns error when no app is connected and auto-connect fails", async () => {
        const { tap } = await import("../../pro/tap.js");
        const { connectedApps } = await import("../../core/state.js");
        connectedApps.clear();
        const result = await tap({ text: "Submit" });
        expect(result.success).toBe(false);
        // Auto-connect will be attempted (scans ports) but may fail or succeed
        // depending on whether Metro is running in the test environment
        expect(result.error || result.method).toBeTruthy();
    }, 15000);

    it("validates that at least one search param is provided", async () => {
        const { tap } = await import("../../pro/tap.js");
        const result = await tap({});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Must provide");
    });

    it("validates x and y are both provided for coordinate tap", async () => {
        const { tap } = await import("../../pro/tap.js");
        const result = await tap({ x: 100 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Both x and y");
    });
});
