import { describe, expect, it } from "@jest/globals";
import { matchTypedText, scriptOf, verdictForTypedText } from "../../core/typedTextVerify.js";

/**
 * Both cases here were found on an iPhone Air simulator, not by reading the
 * code — the original strict-equality compare threw an Error on two completely
 * successful writes.
 */
describe("field-applied formatting vs. a real remap (device-found)", () => {
    it("verifies text the field capitalized itself", () => {
        // RN defaults autoCapitalize="sentences", so this is the common case,
        // not an edge one: every un-opted-out field does it.
        const v = verdictForTypedText({
            sent: "abc",
            expected: "abc",
            landed: "Abc",
            nonLatinKeyboards: ["uk_UA (Ukrainian)"]
        });
        expect(v.status).toBe("verified");
        expect(v.message).toContain("its own formatting");
    });

    it("verifies an append when the prior text could not be known", () => {
        // iOS reports an empty field's AXValue as its PLACEHOLDER and exposes no
        // placeholder attribute to subtract, so `expected` was built as
        // "Search" + the typed text. The tail is what proves delivery.
        const v = verdictForTypedText({
            sent: "envcheck@example.com",
            expected: "Searchenvcheck@example.com",
            landed: "Envcheck@example.com",
            nonLatinKeyboards: []
        });
        expect(v.status).toBe("verified");
    });

    it("still fails the Cyrillic remap that motivated the check", () => {
        const v = verdictForTypedText({
            sent: "envcheck@example.com",
            expected: "envcheck@example.com",
            landed: 'envchус"учфьздуюсщь',
            nonLatinKeyboards: ["uk_UA (Ukrainian)"]
        });
        expect(v.status).toBe("mismatch");
        expect(v.message).toContain("Cyrillic");
        expect(v.message).toContain("uk_UA (Ukrainian)");
    });

    it("still fails when nothing was typed and the placeholder remains", () => {
        const v = verdictForTypedText({
            sent: "abc",
            expected: "Searchabc",
            landed: "Search",
            nonLatinKeyboards: []
        });
        expect(v.status).toBe("mismatch");
    });

    it("still fails a truncated write", () => {
        expect(matchTypedText("envcheck@exa", "envcheck@example.com", "envcheck@example.com")).toBe("none");
    });

    it("does not treat an empty send as proof of anything", () => {
        // "" is a suffix of every string; that must not read as delivered.
        expect(matchTypedText("Search", "Search", "")).toBe("exact");
        expect(matchTypedText("anything else", "Search", "")).toBe("none");
    });
});

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
