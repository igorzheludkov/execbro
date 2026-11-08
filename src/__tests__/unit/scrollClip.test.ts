import { describe, it, expect } from "@jest/globals";
import { clipToScrollers, viewportBottom, SCROLL_CLIP_JS } from "../../core/injected/scrollClip.js";

// Measured on device (Pixel 9 emulator, Tap Targets at scroll top), window points:
// root RCTView (0,-54 411x923); vertical RCTScrollView (0,104 411x668), which ends
// where the bottom tab bar starts; chip row AndroidHorizontalScrollView (0,56 411x48).
const ROOT = { x: 0, y: -54, width: 411, height: 923 };
const VERTICAL = { x: 0, y: 104, width: 411, height: 668 };
const CHIPS = { x: 0, y: 56, width: 411, height: 48 };

describe("viewportBottom", () => {
    it("counts a negative root origin: the window starts below the status bar", () => {
        // numeric-input measured at y=878 is past this edge, so it is off screen.
        expect(viewportBottom(ROOT)).toBe(869);
    });

    it("extends by a positive origin, as before", () => {
        expect(viewportBottom({ x: 0, y: 20, width: 400, height: 800 })).toBe(820);
    });
});

describe("clipToScrollers", () => {
    it("drops an element below its scroll view's bottom edge (behind the tab bar)", () => {
        // password-input measured at (20,818 371x48): inside the window, outside the ScrollView.
        expect(clipToScrollers({ x: 20, y: 818, width: 371, height: 48 }, [VERTICAL])).toBeNull();
    });

    it("keeps only the visible part of a chip cut by a horizontal scroll view", () => {
        // screen-nav-Diagnostics measured at (385,64 101x32): 26pt of it are on screen.
        expect(clipToScrollers({ x: 385, y: 64, width: 101, height: 32 }, [CHIPS])).toEqual({ x: 385, y: 64, width: 26, height: 32 });
    });

    it("leaves a fully visible element unchanged", () => {
        const m = { x: 20, y: 300, width: 100, height: 48 };
        expect(clipToScrollers(m, [VERTICAL])).toEqual(m);
    });

    it("ignores scrollers that were not measured", () => {
        const m = { x: 20, y: 818, width: 371, height: 48 };
        expect(clipToScrollers(m, [null])).toEqual(m);
    });

    it("injected source behaves the same", () => {
        const fn = new Function(`${SCROLL_CLIP_JS}; return clipToScrollers;`)();
        expect(fn({ x: 20, y: 818, width: 371, height: 48 }, [VERTICAL])).toBeNull();
    });
});
