import { describe, it, expect } from "@jest/globals";
import { typeSessions } from "../../core/iosPhysical.js";

describe("typeSessions (USB iPhone keystrokes)", () => {
    it("types the first character alone into a just-focused field", () => {
        expect(typeSessions("Igor", true)).toEqual(["I", "gor"]);
    });
    it("types in one session otherwise, and never splits a single character", () => {
        expect(typeSessions("Igor", false)).toEqual(["Igor"]);
        expect(typeSessions("x", true)).toEqual(["x"]);
    });
});
