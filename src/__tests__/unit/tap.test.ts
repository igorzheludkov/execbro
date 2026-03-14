// src/__tests__/unit/tap.test.ts
import { describe, it, expect } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import {
    type TapQuery,
    type TapResult,
    type TapStrategy,
    buildQuery,
    getAvailableStrategies,
    isNonAscii,
    convertPixelsToPoints,
    formatTapSuccess,
    formatTapFailure,
} from "../../core/tap.js";

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
        expect(getAvailableStrategies({ text: "Submit" }, "auto")).toEqual(["fiber", "accessibility", "ocr"]);
    });
    it("skips fiber for non-ASCII text", () => {
        expect(getAvailableStrategies({ text: "Отправить" }, "auto")).toEqual(["accessibility", "ocr"]);
    });
    it("returns fiber+accessibility for testID", () => {
        expect(getAvailableStrategies({ testID: "btn" }, "auto")).toEqual(["fiber", "accessibility"]);
    });
    it("returns only fiber for component", () => {
        expect(getAvailableStrategies({ component: "Button" }, "auto")).toEqual(["fiber"]);
    });
    it("returns coordinate for x,y", () => {
        expect(getAvailableStrategies({ x: 100, y: 200 }, "auto")).toEqual(["coordinate"]);
    });
    it("returns single strategy when explicitly set", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "ocr")).toEqual(["ocr"]);
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

describe("tap orchestrator", () => {
    it("returns error when no app is connected", async () => {
        const { tap } = await import("../../core/tap.js");
        const { connectedApps } = await import("../../core/state.js");
        connectedApps.clear();
        const result = await tap({ text: "Submit" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("No connected app");
    });

    it("validates that at least one search param is provided", async () => {
        const { tap } = await import("../../core/tap.js");
        const result = await tap({});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Must provide");
    });

    it("validates x and y are both provided for coordinate tap", async () => {
        const { tap } = await import("../../core/tap.js");
        const result = await tap({ x: 100 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Both x and y");
    });
});
