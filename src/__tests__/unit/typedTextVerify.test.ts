import { describe, expect, it } from "@jest/globals";
import { scriptOf, verdictForTypedText } from "../../core/typedTextVerify.js";

describe("scriptOf", () => {
    it("returns null for plain ASCII", () => {
        expect(scriptOf("envcheck@example.com")).toBeNull();
    });

    it("names the script that actually arrived", () => {
        expect(scriptOf("учфьздуюсщь")).toBe("Cyrillic");
        expect(scriptOf("שלום")).toBe("Hebrew");
        expect(scriptOf("δοκιμή")).toBe("Greek");
        expect(scriptOf("مرحبا")).toBe("Arabic");
        expect(scriptOf("テスト")).toBe("Japanese");
    });

    it("names the script even when only part of the text was remapped", () => {
        // The reported case: the first characters survived, the rest did not.
        expect(scriptOf("envchусл\"учфьздуюсщь")).toBe("Cyrillic");
    });
});

describe("verdictForTypedText", () => {
    it("confirms only when the field really holds the expected text", () => {
        const v = verdictForTypedText({
            sent: "hello",
            expected: "hello",
            landed: "hello",
            nonLatinKeyboards: []
        });
        expect(v.status).toBe("verified");
        expect(v.message).toContain('"hello"');
    });

    it("reports a layout remap as a mismatch, naming the script and the fix", () => {
        const v = verdictForTypedText({
            sent: "envcheck@example.com",
            expected: "envcheck@example.com",
            landed: "Ким Русь»учфьздуюсщь",
            nonLatinKeyboards: ["uk_UA (Ukrainian)", "he_IL (Hebrew)"]
        });
        expect(v.status).toBe("mismatch");
        expect(v.message).toContain("did NOT land");
        expect(v.message).toContain("Cyrillic");
        expect(v.message).toContain("uk_UA (Ukrainian)");
        expect(v.message).toContain("input_text");
        // The requested string must never read as a confirmation of receipt.
        expect(v.message).not.toMatch(/^Typed text/);
    });

    it("reports a plain ASCII mismatch without inventing a layout cause", () => {
        const v = verdictForTypedText({
            sent: "CASEB",
            expected: "CASEB",
            landed: "CSEBA",
            nonLatinKeyboards: []
        });
        expect(v.status).toBe("mismatch");
        expect(v.message).not.toContain("keyboard layout");
    });

    it("does not claim success when the field could not be read", () => {
        const v = verdictForTypedText({
            sent: "hello",
            expected: "hello",
            landed: null,
            readError: "axe describe-ui failed",
            nonLatinKeyboards: []
        });
        expect(v.status).toBe("unverified");
        expect(v.message).toContain("NOT verified");
        expect(v.message).toContain("axe describe-ui failed");
    });

    it("warns about non-Latin keyboards even when the read-back failed", () => {
        const v = verdictForTypedText({
            sent: "hello",
            expected: "hello",
            landed: null,
            nonLatinKeyboards: ["uk_UA (Ukrainian)"]
        });
        expect(v.status).toBe("unverified");
        expect(v.message).toContain("uk_UA (Ukrainian)");
    });

    it("treats an append onto existing text as expected, not as corruption", () => {
        const v = verdictForTypedText({
            sent: "world",
            expected: "hello world",
            landed: "hello world",
            nonLatinKeyboards: []
        });
        expect(v.status).toBe("verified");
    });
});
