import { describe, it, expect } from "@jest/globals";
import {
    containsProblematicUnicode,
    stripLeadingComments,
    validateAndPreprocessExpression,
    formatScreenLayoutTree,
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

    it("rejects multi-statement expression", () => {
        const result = validateAndPreprocessExpression("var x = 1; x");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Multi-statement");
        expect(result.error).toContain("IIFE");
    });

    it("rejects multi-statement with console.log", () => {
        const result = validateAndPreprocessExpression("console.log('[TEST] hello'); 1+1");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Multi-statement");
    });

    it("accepts trailing semicolon on a single statement", () => {
        const result = validateAndPreprocessExpression("1 + 1;");
        expect(result.valid).toBe(true);
    });

    it("accepts semicolons inside an IIFE body", () => {
        const result = validateAndPreprocessExpression("(function(){ var x = 1; return x; })()");
        expect(result.valid).toBe(true);
    });

    it("accepts semicolons inside a for-loop header", () => {
        const result = validateAndPreprocessExpression("(function(){ for (var i = 0; i < 3; i++) {} return i; })()");
        expect(result.valid).toBe(true);
    });

    it("accepts semicolons inside string literals", () => {
        const result = validateAndPreprocessExpression("'a;b;c'");
        expect(result.valid).toBe(true);
    });

    it("accepts semicolons inside template literals", () => {
        const result = validateAndPreprocessExpression("`a;b;c`");
        expect(result.valid).toBe(true);
    });
});

describe("formatScreenLayoutTree off-screen summary", () => {
    const stubElement = {
        component: "App",
        path: "App",
        frame: { x: 0, y: 0, width: 100, height: 100 },
        originalIndex: 0,
        parentIndex: -1,
        depth: 0,
    };

    it("omits the summary lines when both arrays are empty", () => {
        const out = formatScreenLayoutTree([stubElement], false, {
            offScreenBelow: [],
            offScreenAbove: [],
        });
        expect(out).not.toContain("below fold");
        expect(out).not.toContain("above fold");
    });

    it("omits the summary when `offScreen` is undefined", () => {
        const out = formatScreenLayoutTree([stubElement]);
        expect(out).not.toContain("below fold");
        expect(out).not.toContain("above fold");
    });

    it("emits a single-name line for one below-fold component", () => {
        const out = formatScreenLayoutTree([stubElement], false, {
            offScreenBelow: ["DayComponent"],
        });
        expect(out).toContain("[... 1 component below fold: DayComponent]");
    });

    it("emits a multi-name line without truncation for <= 10 components", () => {
        const names = ["A", "B", "C", "D", "E"];
        const out = formatScreenLayoutTree([stubElement], false, {
            offScreenBelow: names,
        });
        expect(out).toContain("[... 5 components below fold: A, B, C, D, E]");
    });

    it("truncates at 10 names with a +N-more tail", () => {
        const names = Array.from({ length: 14 }, (_, i) => `C${i + 1}`);
        const out = formatScreenLayoutTree([stubElement], false, {
            offScreenBelow: names,
        });
        expect(out).toContain(
            "[... 14 components below fold: C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, ... +4 more]"
        );
    });

    it("emits above and below lines in that order when both are present", () => {
        const out = formatScreenLayoutTree([stubElement], false, {
            offScreenAbove: ["TopHeader"],
            offScreenBelow: ["FooterBanner"],
        });
        const aboveIdx = out.indexOf("above fold");
        const belowIdx = out.indexOf("below fold");
        expect(aboveIdx).toBeGreaterThan(-1);
        expect(belowIdx).toBeGreaterThan(aboveIdx);
    });

    it("separates the tree from the summary with a blank line", () => {
        const out = formatScreenLayoutTree([stubElement], false, {
            offScreenBelow: ["X"],
        });
        expect(out.split("\n").length).toBeGreaterThanOrEqual(3);
        const lines = out.split("\n");
        const summaryLineIdx = lines.findIndex((l) => l.includes("below fold"));
        expect(lines[summaryLineIdx - 1]).toBe("");
    });
});
