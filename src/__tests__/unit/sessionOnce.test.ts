import { describe, it, expect } from "@jest/globals";
import { changedSinceLastShown, resetSessionOnce } from "../../core/sessionOnce.js";

describe("changedSinceLastShown", () => {
    it("shows first time, hides repeats, shows on change", () => {
        resetSessionOnce();
        expect(changedSinceLastShown("deviceNote", "a")).toBe(true);
        expect(changedSinceLastShown("deviceNote", "a")).toBe(false);
        expect(changedSinceLastShown("deviceNote", "b")).toBe(true);
    });

    it("keeps slots independent", () => {
        resetSessionOnce();
        expect(changedSinceLastShown("shot-preamble:emulator-5554", "1")).toBe(true);
        expect(changedSinceLastShown("shot-preamble:UDID", "1")).toBe(true);
        expect(changedSinceLastShown("shot-preamble:emulator-5554", "1")).toBe(false);
    });
});
