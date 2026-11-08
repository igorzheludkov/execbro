import { describe, it, expect } from "@jest/globals";
import { renderTapResponse, compactVerification, formatScroll, renderSwipeResponse, withScroll, attachOutcome, isDialogResponse } from "../../pro/actionRender.js";
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

    it("keeps where the tap landed, the input inspect_at_point takes", () => {
        const out = renderTapResponse({ ...accessibilityTap, tappedAt: { x: 143, y: 907 } }, null, { verbose: false, showDeviceNote: false });
        expect(out.tappedAt).toEqual({ x: 143, y: 907 });
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

    it("does not present an accessibility role as a component", () => {
        // iOS accessibility taps report the AX role (GenericElement, Button) in `component`.
        const r: TapResult = { ...accessibilityTap, component: "GenericElement", text: "Submit" };
        expect(renderTapResponse(r, null, { verbose: false, showDeviceNote: false }).target).toBe('testID="submit-btn" → "Submit"');
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

describe("formatScroll", () => {
    it("reports the scroll container's offset before and after", () => {
        expect(formatScroll(
            { found: true, offset: 0, maxOffset: 1240, component: "ScrollView" },
            { found: true, offset: 660, maxOffset: 1240, component: "ScrollView" }
        )).toBe("ScrollView y 0 → 660 of 1240");
    });

    it("uses x for a horizontal container and a generic name when unnamed", () => {
        expect(formatScroll({ found: true, horizontal: true, offset: 10.4, maxOffset: 300 }, { found: true, horizontal: true, offset: 200, maxOffset: 300 }))
            .toBe("scroll view x 10 → 200 of 300");
    });

    it("is undefined when either probe could not look", () => {
        expect(formatScroll({ found: false, unavailable: true }, { found: true, offset: 1 })).toBeUndefined();
        expect(formatScroll({ found: true, offset: 1 }, { found: false })).toBeUndefined();
    });
});

describe("renderSwipeResponse", () => {
    const body = {
        verification: { meaningful: true, changeRate: 0.13, changedPixels: 231354, totalPixels: 1677753, regions: [{ x: 32, y: 341, width: 816, height: 784, changedPixels: 1 }], explanation: "Swipe caused ..." },
        outcome: { scroll: "ScrollView y 0 → 660 of 1240" },
        platform: "android", from: { x: 446, y: 1330 }, to: { x: 446, y: 670 },
        driverMessage: "Swiped from (541, 1612) to (541, 812) in 300ms",
        deviceNote: "defaulted to ...",
    };

    it("slim swipe keeps outcome and verdict only", () => {
        expect(renderSwipeResponse(body, { verbose: false, showDeviceNote: false })).toEqual({
            success: true,
            outcome: { scroll: "ScrollView y 0 → 660 of 1240" },
            verification: { meaningful: true, regions: ["(440,733) 816x784"] },
        });
    });

    it("verbose adds geometry, driver message and the full verification", () => {
        expect(renderSwipeResponse(body, { verbose: true, showDeviceNote: false })).toMatchObject({
            platform: "android", from: body.from, to: body.to, driverMessage: body.driverMessage, verification: { changeRate: 0.13 },
        });
    });

    it("keeps warnings", () => {
        expect(renderSwipeResponse({ ...body, warning: "Swipe executed but nothing moved: already at end" }, { verbose: false, showDeviceNote: false }).warning)
            .toBe("Swipe executed but nothing moved: already at end");
    });
});

describe("withScroll", () => {
    it("replaces the text diff with one line when the list scrolled: rows mounting and unmounting are not changes", () => {
        const o = withScroll({ route: "unchanged (Feed)", text: ['+ "Row 41"', '- "Row 1"'] }, { found: true, offset: 0, maxOffset: 900 }, { found: true, offset: 473, maxOffset: 900 });
        expect(o).toEqual({
            route: "unchanged (Feed)",
            scroll: "scroll view y 0 → 473 of 900",
            text: ["2 text line(s) changed while the list scrolled (not listed): get_screen_state reads the screen"],
        });
    });

    it("keeps the text diff on an overscroll or pull-to-refresh: the content may really have changed", () => {
        const o = withScroll({ text: ['+ "Updated just now"'] }, { found: true, offset: 0 }, { found: true, offset: -60 });
        expect(o.text).toEqual(['+ "Updated just now"']);
    });

    it("keeps the text diff when nothing scrolled (a swipe that dismissed a sheet, flipped a pager)", () => {
        const o = withScroll({ text: ['- "Sheet title"'] }, { found: true, offset: 0 }, { found: true, offset: 0 });
        expect(o.text).toEqual(['- "Sheet title"']);
    });

    it("leaves the outcome alone when the probes could not look", () => {
        const o = withScroll({ text: ["x"] }, null, null);
        expect(o).toEqual({ text: ["x"] });
    });
});

describe("attachOutcome (chromium swipe)", () => {
    const response = (body: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }, { type: "image" as const, data: "x", mimeType: "image/jpeg" }], isError: false });

    it("adds the outcome to the JSON body and keeps the image", () => {
        const r = attachOutcome(response({ success: true, scrolled: { dx: 0, dy: 0 } }), { route: "unchanged (/inbox)", console: ["✖ error boom"] });
        expect(JSON.parse(r.content[0].text!)).toEqual({ success: true, scrolled: { dx: 0, dy: 0 }, outcome: { route: "unchanged (/inbox)", console: ["✖ error boom"] } });
        expect(r.content[1]).toEqual({ type: "image", data: "x", mimeType: "image/jpeg" });
    });

    it("replaces the text diff with one line when the page scrolled", () => {
        const r = attachOutcome(response({ success: true, scrolled: { dx: 0, dy: 400 } }), { text: ['+ "Row 41"'], route: "unchanged (/feed)" });
        expect(JSON.parse(r.content[0].text!).outcome).toEqual({
            route: "unchanged (/feed)",
            text: ["1 text line(s) changed while the list scrolled (not listed): get_screen_state reads the screen"],
        });
    });

    it("recognises a swipe that opened a dialog: the page is paused, there is nothing to read", () => {
        expect(isDialogResponse(response({ success: true, dialog: { type: "alert", message: "hi" } }))).toBe(true);
        expect(isDialogResponse(response({ success: true }))).toBe(false);
    });

    it("leaves an error response untouched", () => {
        const err = { content: [{ type: "text" as const, text: "Error: no window" }], isError: true };
        expect(attachOutcome(err, { route: "x" })).toBe(err);
    });
});
