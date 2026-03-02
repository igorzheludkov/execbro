import { describe, it, expect } from "@jest/globals";
import {
    containsProblematicUnicode,
    stripLeadingComments,
    validateAndPreprocessExpression,
} from "../../core/executor.js";

describe("containsProblematicUnicode", () => {
    it("returns false for ASCII text", () => {
        expect(containsProblematicUnicode("hello world")).toBe(false);
    });

    it("returns false for basic Unicode (BMP)", () => {
        expect(containsProblematicUnicode("café")).toBe(false);
    });

    it("returns true for emoji (surrogate pairs)", () => {
        expect(containsProblematicUnicode("hello 😀")).toBe(true);
    });

    it("returns true for flag emoji", () => {
        expect(containsProblematicUnicode("🇺🇸")).toBe(true);
    });

    it("returns false for empty string", () => {
        expect(containsProblematicUnicode("")).toBe(false);
    });
});

describe("stripLeadingComments", () => {
    it("returns expression unchanged when no comments", () => {
        expect(stripLeadingComments("1 + 1")).toBe("1 + 1");
    });

    it("strips single-line comment", () => {
        expect(stripLeadingComments("// comment\n1 + 1")).toBe("1 + 1");
    });

    it("strips multiple single-line comments", () => {
        expect(stripLeadingComments("// one\n// two\n1 + 1")).toBe("1 + 1");
    });

    it("strips multi-line comment", () => {
        expect(stripLeadingComments("/* comment */1 + 1")).toBe("1 + 1");
    });

    it("returns empty string when entire expression is a comment", () => {
        expect(stripLeadingComments("// just a comment")).toBe("");
    });

    it("returns expression with unclosed multi-line comment", () => {
        expect(stripLeadingComments("/* unclosed")).toBe("/* unclosed");
    });

    it("strips leading whitespace before comments", () => {
        expect(stripLeadingComments("  // comment\n42")).toBe("42");
    });
});

describe("validateAndPreprocessExpression", () => {
    it("accepts valid simple expression", () => {
        const result = validateAndPreprocessExpression("1 + 1");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("1 + 1");
    });

    it("rejects expression with emoji", () => {
        const result = validateAndPreprocessExpression("console.log('😀')");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("emoji");
    });

    it("rejects empty expression after stripping comments", () => {
        const result = validateAndPreprocessExpression("// just a comment");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("empty");
    });

    it("rejects top-level async function", () => {
        const result = validateAndPreprocessExpression("async () => { await fetch() }");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("async");
    });

    it("rejects async IIFE", () => {
        const result = validateAndPreprocessExpression("(async () => { await fetch() })()");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("async");
    });

    it("strips comments and validates remaining expression", () => {
        const result = validateAndPreprocessExpression("// setup\n__DEV__");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("__DEV__");
    });

    it("accepts multi-statement expression", () => {
        const result = validateAndPreprocessExpression("var x = 1; x");
        expect(result.valid).toBe(true);
    });
});
