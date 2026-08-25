import { describe, it, expect } from "@jest/globals";
import { sheetShiftY, SHEET_HELPERS_JS } from "../../core/injected/sheetOffset.js";

// Measured on device (iPhone Air, RN 0.83 / Fabric, react-native-screens
// presentation:'modal'): the window is 420x912pt, the sheet's own host measures
// 420x844 at (0,0), and a switch reporting y=375.7 has its pixels at y=443.7.
// 912 - 844 = 68, which is exactly the error.
const WINDOW = { width: 420, height: 912 };

describe("sheetShiftY", () => {
    it("derives the measured inset from the sheet's own height", () => {
        expect(sheetShiftY({ x: 0, y: 0, width: 420, height: 844 }, WINDOW)).toBe(68);
    });

    it("is zero for a full-screen presentation", () => {
        expect(sheetShiftY({ x: 0, y: 0, width: 420, height: 912 }, WINDOW)).toBe(0);
    });

    it("is zero when the platform already reports absolute coordinates", () => {
        // Android draws modals in-window: origin is real, so bottom - (y+h) == 0.
        expect(sheetShiftY({ x: 0, y: 68, width: 420, height: 844 }, WINDOW)).toBe(0);
    });

    it("scales with a detented half sheet, which is still bottom-anchored", () => {
        expect(sheetShiftY({ x: 0, y: 0, width: 420, height: 456 }, WINDOW)).toBe(456);
    });

    it("refuses to guess when the sheet is not full-width", () => {
        // An iPad form sheet is centred, not bottom-anchored. Replacing a known
        // error with an invented one is worse than leaving the frame alone.
        expect(sheetShiftY({ x: 60, y: 0, width: 300, height: 700 }, WINDOW)).toBe(0);
    });

    it("returns 0 rather than throwing on missing or degenerate input", () => {
        expect(sheetShiftY(null, WINDOW)).toBe(0);
        expect(sheetShiftY(undefined, WINDOW)).toBe(0);
        expect(sheetShiftY({ x: 0, y: 0, width: 0, height: 0 }, WINDOW)).toBe(0);
        expect(sheetShiftY({ x: 0, y: 0, width: 420, height: 844 }, null)).toBe(0);
        // Taller than the window (over-scrolled container) must not shift upward.
        expect(sheetShiftY({ x: 0, y: 0, width: 420, height: 1000 }, WINDOW)).toBe(0);
    });
});

describe("SHEET_HELPERS_JS", () => {
    // The walkers run inside Hermes against this source, not the module above; a
    // divergent copy is the failure mode this file exists to prevent.
    it("evaluates to the same function the Node side uses", () => {
        const fn = new Function(`${SHEET_HELPERS_JS} return sheetShiftY;`)() as typeof sheetShiftY;
        expect(fn({ x: 0, y: 0, width: 420, height: 844 }, WINDOW)).toBe(68);
        expect(fn({ x: 0, y: 0, width: 420, height: 912 }, WINDOW)).toBe(0);
    });

    it("walks up to the modal boundary and stops at ordinary hosts", () => {
        const ctx = new Function(
            `${SHEET_HELPERS_JS} return { modalBoundaryOf: modalBoundaryOf, shiftRect: shiftRect };`
        )() as {
            modalBoundaryOf: (f: unknown) => unknown;
            shiftRect: (m: unknown, dy: number) => { y: number };
        };
        const sheet = { type: "RNSModalScreen", memoizedProps: {}, return: null };
        const view = { type: "RCTView", memoizedProps: {}, return: sheet };
        const leaf = { type: "RCTSwitch", memoizedProps: {}, return: view };
        expect(ctx.modalBoundaryOf(leaf)).toBe(sheet);

        const pushed = { type: "RNSScreen", memoizedProps: { stackPresentation: "push" }, return: null };
        expect(ctx.modalBoundaryOf({ type: "RCTView", memoizedProps: {}, return: pushed })).toBeNull();

        // Older react-native-screens reuses RNSScreen and carries it in a prop.
        const legacy = { type: "RNSScreen", memoizedProps: { stackPresentation: "formSheet" }, return: null };
        expect(ctx.modalBoundaryOf({ type: "RCTView", memoizedProps: {}, return: legacy })).toBe(legacy);

        expect(ctx.shiftRect({ x: 1, y: 10, width: 2, height: 3 }, 68).y).toBe(78);
    });
});
