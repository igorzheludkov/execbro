import { describe, it, expect } from "@jest/globals";
import {
    toScreenSpaceY,
    fromScreenSpaceY,
    SCREEN_SPACE_HELPER_JS,
    type ScreenSpaceMetrics
} from "../../core/screenSpace.js";

const IOS: ScreenSpaceMetrics = { platform: "ios", topInset: 59 };
const ANDROID: ScreenSpaceMetrics = { platform: "android", topInset: 54 };

describe("toScreenSpaceY", () => {
    // Android measureInWindow is relative to the app window, which starts below the
    // status bar. Measured on device: a header button at 7dp renders at 61dp, and the
    // screenshot formatter has always added the status bar to match.
    it("always adds the status bar on Android", () => {
        expect(toScreenSpaceY(7, ANDROID)).toBe(61);
        expect(toScreenSpaceY(569, ANDROID)).toBe(623);
    });

    // iOS already includes the status bar for a normally-presented screen. Measured on
    // device: get_screen_state and raw measureInWindow agree exactly (RoleButton "Yes"
    // at (104,569) in both), so shifting here would break correct coordinates.
    it("leaves a normally-presented iOS screen untouched", () => {
        expect(toScreenSpaceY(75, IOS)).toBe(75);
        expect(toScreenSpaceY(569, IOS)).toBe(569);
        expect(toScreenSpaceY(59, IOS)).toBe(59);
    });

    // A react-native-screens modal measures from its own container. Measured on device:
    // the Register button reports y=29 but renders at y=88 — one inset lower.
    it("shifts an iOS element measured inside the safe-area band", () => {
        expect(toScreenSpaceY(29, IOS)).toBe(88);
        expect(toScreenSpaceY(0, IOS)).toBe(59);
    });

    it("is a no-op when the inset is unknown", () => {
        expect(toScreenSpaceY(29, { platform: "ios", topInset: 0 })).toBe(29);
        expect(toScreenSpaceY(7, { platform: "android", topInset: 0 })).toBe(7);
    });
});

describe("fromScreenSpaceY", () => {
    it("round-trips Android", () => {
        for (const y of [0, 7, 569, 1200]) {
            expect(fromScreenSpaceY(toScreenSpaceY(y, ANDROID), ANDROID)).toBe(y);
        }
    });

    // Only the band that the forward map can produce is unshifted. Values at or above
    // 2*inset were never shifted, so unshifting them would corrupt correct input.
    it("round-trips the iOS modal band and leaves ordinary values alone", () => {
        for (const y of [0, 29, 58]) {
            expect(fromScreenSpaceY(toScreenSpaceY(y, IOS), IOS)).toBe(y);
        }
        expect(fromScreenSpaceY(400, IOS)).toBe(400);
        expect(fromScreenSpaceY(118, IOS)).toBe(118);
    });
});

describe("SCREEN_SPACE_HELPER_JS", () => {
    // The injected walkers must apply the identical rule; a divergent second copy is
    // what produced the mismatch this module exists to remove.
    it("evaluates to a function matching the Node implementation", () => {
        const fn = new Function(`${SCREEN_SPACE_HELPER_JS} return toScreenSpaceY;`)() as typeof toScreenSpaceY;
        expect(fn(29, IOS)).toBe(88);
        expect(fn(75, IOS)).toBe(75);
        expect(fn(7, ANDROID)).toBe(61);
    });
});
