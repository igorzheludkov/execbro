import { describe, it, expect } from "@jest/globals";
import { explainCoordinateMiss } from "../../pro/coordinateMiss.js";
import type { ScreenState } from "../../core/screenState.js";

const pressable = (over: Partial<Record<string, unknown>> = {}) => ({
    label: null,
    component: null,
    testID: null,
    center: { x: 0, y: 0 },
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    ...over,
}) as never;

/**
 * Modelled on the real repro: an "Insufficient Balance" bottom sheet with an OK
 * button, over a screen whose own buttons are covered by the sheet.
 */
const sheetState = {
    route: { name: "OneGiftAtATime", params: null, stack: [] },
    overlays: [
        {
            type: "BottomSheet",
            title: null,
            pressables: [
                pressable({
                    label: "OK",
                    component: "Button",
                    center: { x: 210, y: 834 },
                    bounds: { x: 20, y: 806, width: 380, height: 56 },
                }),
            ],
            texts: [
                {
                    text: "It looks like there aren't enough funds to add this gift.",
                    center: { x: 210, y: 734 },
                    bounds: { x: 41, y: 700, width: 338, height: 70 },
                },
            ],
        },
    ],
    pressables: [
        // Sits directly under the sheet's OK button (same band) — a tap there
        // reaches OK, not this.
        pressable({
            label: "Proceed to Checkout",
            component: "Button",
            center: { x: 210, y: 838 },
            bounds: { x: 20, y: 810, width: 380, height: 56 },
            blockedByOverlay: true,
        }),
        // Higher up the screen, covered by the sheet but overlapping nothing
        // reachable — the pure "you targeted something behind an overlay" case.
        pressable({
            label: "Clear Cart and Add New Item",
            component: "Button",
            center: { x: 210, y: 774 },
            bounds: { x: 20, y: 746, width: 380, height: 56 },
            blockedByOverlay: true,
        }),
    ],
    texts: [],
    images: [],
} as unknown as ScreenState;

describe("explainCoordinateMiss", () => {
    it("names the text it hit and points at the nearest reachable pressable", () => {
        // The exact miss from the live session: 100pt above the OK button.
        const d = explainCoordinateMiss({ x: 210, y: 734 }, sheetState);

        expect(d).not.toBeNull();
        expect(d!.hit).toContain("It looks like there aren't enough funds");
        expect(d!.nearest?.label).toBe("OK");
        expect(d!.nearest?.center).toEqual({ x: 210, y: 834 });
        expect(d!.nearest?.direction).toBe("below");
        expect(d!.suggestion).toContain("(210, 834)");
    });

    it("says so when the point landed on something an overlay covers", () => {
        // "Clear Cart and Add New Item" is visible in the screenshot but unreachable.
        const d = explainCoordinateMiss({ x: 210, y: 774 }, sheetState);

        expect(d!.blockedByOverlay).toBe(true);
        expect(d!.hit).toContain("Clear Cart and Add New Item");
        expect(d!.hit).toContain("BottomSheet");
        expect(d!.suggestion).toMatch(/Dismiss the BottomSheet/);
        // It must still offer the reachable alternative.
        expect(d!.suggestion).toContain("(210, 834)");
    });

    it("prefers the reachable overlay button when it overlaps a covered element", () => {
        // (210,834) is inside BOTH the sheet's OK button and the covered
        // "Proceed to Checkout" beneath it. The touch reaches OK, so the
        // diagnosis must describe OK — not the element behind it.
        const d = explainCoordinateMiss({ x: 210, y: 834 }, sheetState);

        expect(d!.hit).toContain("OK");
        expect(d!.hit).not.toContain("Proceed to Checkout");

        expect(d!.blockedByOverlay).toBe(false);
        expect(d!.suggestion).toContain("coordinates were correct");
        expect(d!.suggestion).toMatch(/onPress handler/);
        // No "nearest" steer — the aim was fine.
        expect(d!.nearest).toBeUndefined();
    });

    it("reports empty space when the point hit nothing at all", () => {
        const d = explainCoordinateMiss({ x: 5, y: 20 }, sheetState);

        expect(d!.hit).toBe("no element (empty space)");
        expect(d!.nearest?.label).toBe("OK");
    });

    it("converts suggested coordinates into the caller's space", () => {
        // Caller works in screenshot pixels at ~2.19 px per point.
        const d = explainCoordinateMiss({ x: 210, y: 734 }, sheetState, (v) => Math.round(v * 2.19));

        expect(d!.nearest?.center).toEqual({ x: 460, y: 1826 });
        expect(d!.suggestion).toContain("(460, 1826)");
    });

    it("returns null when the screen state carries nothing to reason about", () => {
        const empty = { route: null, overlays: [], pressables: [], texts: [], images: [] } as unknown as ScreenState;
        expect(explainCoordinateMiss({ x: 1, y: 1 }, empty)).toBeNull();
    });
});
