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

    it("rejects empty expression after stripping comments", () => {
        const result = validateAndPreprocessExpression("// just a comment");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("empty");
    });

    // Hermes compiles async arrows/functions fine — they are expressions, and the
    // manual-await wrapper resolves the Promise they return. Verified on-device
    // (iOS 26 sim, Hermes): `(async () => { const r = await Promise.resolve(41);
    // return r + 1; })()` evaluates to 42. Only a BARE top-level `await` is a
    // genuine syntax error, because the wrapper emits `var __v=(<expr>);`.
    it("accepts an async arrow expression", () => {
        const result = validateAndPreprocessExpression("async () => { await fetch() }");
        expect(result.valid).toBe(true);
    });

    it("accepts async IIFE", () => {
        const result = validateAndPreprocessExpression("(async () => { await fetch() })()");
        expect(result.valid).toBe(true);
    });

    it("points require() callers at Metro's __r registry", () => {
        const result = validateAndPreprocessExpression("require('react-native').Dimensions.get('window')");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("require()");
        expect(result.error).toContain("__r");
    });

    it("strips comments and validates remaining expression", () => {
        const result = validateAndPreprocessExpression("// setup\n__DEV__");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("__DEV__");
    });

    // The manual-await path emits `var __v=(<expr>);`, so a top-level `;` really
    // does break compilation. Rather than reject, rewrite into the IIFE the old
    // error message used to ask the caller to write by hand.
    it("auto-wraps a multi-statement expression into an IIFE", () => {
        const result = validateAndPreprocessExpression("var x = 1; x");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("(function(){ var x = 1; return x; })()");
        expect(result.rewritten).toBe("iife-wrap");
    });

    it("auto-wraps multi-statement with console.log, returning the final value", () => {
        const result = validateAndPreprocessExpression("console.log('[TEST] hello'); 1+1");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("(function(){ console.log('[TEST] hello'); return 1+1; })()");
    });

    it("auto-wraps the real-world globalThis assignment pattern", () => {
        const result = validateAndPreprocessExpression("globalThis.__perfRow=0; globalThis.__perfMount=0; 'ok'");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe(
            "(function(){ globalThis.__perfRow=0; globalThis.__perfMount=0; return 'ok'; })()"
        );
    });

    it("does not auto-wrap when the final statement cannot yield a value", () => {
        const result = validateAndPreprocessExpression("var x = 1; if (x) { x++ }");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Multi-statement");
        expect(result.error).toContain("IIFE");
    });

    it("does not auto-wrap when the final statement is a declaration", () => {
        const result = validateAndPreprocessExpression("var x = 1; var y = 2");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Multi-statement");
    });

    it("preserves an explicit trailing return when auto-wrapping", () => {
        const result = validateAndPreprocessExpression("var x = 1; return x");
        expect(result.valid).toBe(true);
        expect(result.expression).toBe("(function(){ var x = 1; return x; })()");
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

    it("rejects bare top-level await with a targeted error", () => {
        const result = validateAndPreprocessExpression("await fetch('/x')");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/top-level await is not supported in Hermes/i);
        expect(result.error).toMatch(/Promise\.resolve\(\)\.then/);
    });

    it("accepts async function expressions", () => {
        const result = validateAndPreprocessExpression("async function x() { return 1 }");
        expect(result.valid).toBe(true);
    });

    it("accepts a concise async arrow IIFE", () => {
        const result = validateAndPreprocessExpression("(async () => 1)()");
        expect(result.valid).toBe(true);
    });

    it("still rejects a bare top-level await inside an async IIFE's caller position", () => {
        const result = validateAndPreprocessExpression("await (async () => 1)()");
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/top-level await is not supported in Hermes/i);
    });

    it("allows Promise.resolve().then() chains", () => {
        const result = validateAndPreprocessExpression("Promise.resolve(1).then(v => v + 1)");
        expect(result.valid).toBe(true);
    });

    it("does not flag the substring 'await' inside an identifier or string", () => {
        const result = validateAndPreprocessExpression('"keep awaiting"');
        expect(result.valid).toBe(true);
    });

    it("does not flag `awaiting` as a variable name", () => {
        const result = validateAndPreprocessExpression("awaiting");
        expect(result.valid).toBe(true);
    });
});

describe("validateAndPreprocessExpression — non-ASCII handling", () => {
    it("auto-escapes Arabic in a string literal and accepts the expression", () => {
        const result = validateAndPreprocessExpression('"اللغة"');
        expect(result.valid).toBe(true);
        expect(result.expression).toContain("\\u0627");
        expect(result.expression).not.toContain("اللغة");
    });

    it("auto-escapes emoji in a string literal", () => {
        const result = validateAndPreprocessExpression('"hi 😀"');
        expect(result.valid).toBe(true);
        expect(result.expression).toContain("\\u{1F600}");
    });

    it("accepts plain non-emoji non-ASCII (still escaped) inside a literal", () => {
        const result = validateAndPreprocessExpression('"café"');
        expect(result.valid).toBe(true);
        expect(result.expression).toContain("\\u00E9");
    });

    it("falls back to a structured reject on unbalanced quotes", () => {
        const result = validateAndPreprocessExpression('"unterminated');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/unable to auto-escape/i);
        expect(result.error).toMatch(/\\u/);
    });

    it("leaves regex literal contents alone (no false escape)", () => {
        const result = validateAndPreprocessExpression("/[abc]/.test('x')");
        expect(result.valid).toBe(true);
        expect(result.expression).toContain("/[abc]/");
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
