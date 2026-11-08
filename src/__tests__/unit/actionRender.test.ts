import { describe, it, expect } from "@jest/globals";
import { renderTapResponse, compactVerification } from "../../pro/actionRender.js";
import type { TapResult } from "../../pro/tap.js";

// The accessibility tap on Submit measured on the Pixel 9 emulator: about 1,250
// characters of JSON for a yes/no answer.
const accessibilityTap: TapResult = {
    success: true,
    method: "accessibility",
    query: { testID: "submit-btn" },
    pressed: "android.view.ViewGroup",
    component: "android.view.ViewGroup",
    convertedTo: { x: 173, y: 1101, unit: "pixels" },
    platform: "android",
    device: "Pixel_9_-_16kb",
    deviceNote: "defaulted to Pixel_9_-_16kb (emulator-5554) - last used 2026-11-08; pass device= to override.",
    verification: {
        meaningful: true,
        changeRate: 0.0011747855614026618,
        changedPixels: 1971,
        totalPixels: 1677753,
        regions: [{ x: 128, y: 773, width: 176, height: 48, changedPixels: 1540 }],
        explanation: "Tap caused a visible UI change ...",
    },
};

describe("renderTapResponse", () => {
    it("slim tap drops noise and keeps the verdict", () => {
        const out = renderTapResponse(accessibilityTap, { route: "unchanged (TapTargets)", text: ['"Taps: 0" → "Taps: 1"'] }, { verbose: false, showDeviceNote: false });
        expect(out).toEqual({
            success: true,
            method: "accessibility",
            target: 'testID="submit-btn"',
            outcome: { route: "unchanged (TapTargets)", text: ['"Taps: 0" → "Taps: 1"'] },
            verification: { meaningful: true, regions: ["(216,797) 176x48"] },
        });
    });

    it("verbose restores everything", () => {
        const out = renderTapResponse(accessibilityTap, null, { verbose: true, showDeviceNote: false });
        expect(out).toMatchObject({
            convertedTo: { x: 173, y: 1101, unit: "pixels" },
            verification: { changeRate: 0.0011747855614026618 },
        });
    });

    it("prints the device note only when asked to", () => {
        expect(renderTapResponse(accessibilityTap, null, { verbose: false, showDeviceNote: true }).deviceNote).toBe(accessibilityTap.deviceNote);
    });

    it("names a non-native component and the resolved text", () => {
        const r: TapResult = { ...accessibilityTap, method: "fiber", component: "SubmitButton", text: "Submit", query: { text: "subm" } };
        expect(renderTapResponse(r, null, { verbose: false, showDeviceNote: false }).target).toBe('text="subm" → "Submit" <SubmitButton>');
    });

    it("keeps the failure fields an agent acts on", () => {
        const r: TapResult = {
            success: false, method: "ocr", query: { text: "Buy" }, error: "No element found matching text=\"Buy\"",
            attempted: [{ strategy: "fiber", reason: "no match" }], suggestion: "Try tap(x, y) from a screenshot",
        } as TapResult;
        const out = renderTapResponse(r, null, { verbose: false, showDeviceNote: false });
        expect(out).toMatchObject({ success: false, error: r.error, attempted: r.attempted, suggestion: r.suggestion, target: 'text="Buy"' });
    });
});

describe("compactVerification", () => {
    it("keeps explanation when nothing changed", () => {
        expect(compactVerification({ meaningful: false, explanation: "no visible change ..." })).toEqual({ meaningful: false, explanation: "no visible change ..." });
    });

    it("keeps the skip reason", () => {
        expect(compactVerification({ skipped: true, skippedReason: "verify=false", explanation: "Verification skipped." })).toEqual({
            skipped: true,
            skippedReason: "verify=false",
            explanation: "Verification skipped.",
        });
    });

    it("caps regions at 5", () => {
        const regions = Array.from({ length: 7 }, (_, i) => ({ x: 0, y: i * 100, width: 10, height: 10, changedPixels: 1 }));
        expect((compactVerification({ meaningful: true, regions, explanation: "" }).regions as string[]).length).toBe(5);
    });
});
