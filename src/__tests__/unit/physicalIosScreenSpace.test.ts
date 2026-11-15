import { describe, it, expect } from "@jest/globals";

/**
 * A USB iPhone is invisible to simctl, so its scale and top inset come from the
 * app (Dimensions + StatusBarManager). Before this, the layout tools printed
 * points while screenshot and tap spoke pixels, and inspect_at_point read a
 * screenshot coordinate as points: (134, 806) px, the Submit button on an
 * iPhone 11, came back as the "cents" field 403 pt down.
 */
const { parseInAppMetrics } = await import("../../core/screenSpaceDevice.js");
const { toDeliveredPxX, toDeliveredPxY, fromDeliveredPxY } = await import("../../core/screenSpace.js");
const { buildHidDragScript } = await import("../../core/iosPhysical.js");

describe("parseInAppMetrics", () => {
    it("turns an iPhone 11's points into its 828x1792 screenshot pixels", () => {
        const m = parseInAppMetrics(JSON.stringify({ scale: 2, width: 414, height: 896, top: 48 }))!;
        expect(m.pixelScale).toBe(2);
        expect(m.topInset).toBe(48);
        // The Submit button, measured at (67, 403) pt, is at (134, 806) in the screenshot.
        expect(toDeliveredPxX(67, m)).toBe(134);
        expect(toDeliveredPxY(403, m)).toBe(806);
        expect(fromDeliveredPxY(806, m)).toBe(403);
    });

    it("applies the delivery downscale on a screen larger than the image cap", () => {
        // 430x932 @3 = 1290x2796, delivered at 2000 px tall.
        const m = parseInAppMetrics(JSON.stringify({ scale: 3, width: 430, height: 932, top: 59 }))!;
        expect(m.pixelScale).toBeCloseTo(2000 / 932, 5);
    });

    it("reports the scale as unknown rather than guessing", () => {
        expect(parseInAppMetrics(JSON.stringify({ scale: null, width: 414, height: 896 }))).toBeNull();
        expect(parseInAppMetrics("not json")).toBeNull();
        expect(parseInAppMetrics(undefined)).toBeNull();
    });
});

describe("buildHidDragScript", () => {
    it("settles the stream, then drags with ~60 Hz samples", () => {
        expect(buildHidDragScript({ x: 100, y: 200 }, { x: 100, y: 50 }, 300)).toBe("sleep 0.5\ndrag 100 200 100 50 19 0.3\n");
    });
});

const { phoneKeyFor } = await import("../../core/iosPhysical.js");
const { parseKeyCombo } = await import("../../core/chromium.js");

describe("phoneKeyFor", () => {
    const map = (k: string) => {
        const c = parseKeyCombo(k);
        if ("error" in c) throw new Error(c.error);
        return phoneKeyFor(c);
    };

    it("sends named keys by their pymobiledevice3 names", () => {
        expect(map("Enter")).toEqual({ named: "enter" });
        expect(map("Backspace")).toEqual({ named: "backspace" });
        expect(map("ArrowLeft")).toEqual({ named: "left" });
        expect(map("esc")).toEqual({ named: "escape" });
    });

    it("types printable characters, Shift included", () => {
        expect(map("a")).toEqual({ char: "a" });
        expect(map("Shift+a")).toEqual({ char: "A" });
        expect(map("Space")).toEqual({ char: " " });
    });

    it("refuses what it cannot send faithfully instead of sending a bare key", () => {
        // Shift+Tab arriving as Tab would move focus the wrong way.
        expect(map("Shift+Tab")).toHaveProperty("error");
        expect(map("Meta+K")).toHaveProperty("error");
        expect(map("Home")).toHaveProperty("error");
        expect(map("F5")).toHaveProperty("error");
    });
});
