import { describe, it, expect } from "@jest/globals";
import { escapeNonAsciiInStringLiterals } from "../../core/escapeNonAscii";

function run(src: string): string {
    const r = escapeNonAsciiInStringLiterals(src);
    if (!r.ok) throw new Error("recognizer failed: " + r.reason);
    return r.expression;
}

describe("escapeNonAsciiInStringLiterals — happy paths", () => {
    it("is a no-op on a plain ASCII expression", () => {
        expect(run("1 + 2")).toBe("1 + 2");
    });

    it("is a no-op when there are no literals", () => {
        expect(run("foo.bar.baz")).toBe("foo.bar.baz");
    });

    it("escapes Arabic in a double-quoted string", () => {
        const out = run('"اللغة"');
        expect(out).toBe('"\\u0627\\u0644\\u0644\\u063A\\u0629"');
    });

    it("escapes Arabic in a single-quoted string", () => {
        expect(run("'اللغة'")).toContain("\\u0627");
    });

    it("escapes emoji (astral) using \\u{...} form", () => {
        const out = run('"😀"');
        expect(out).toBe('"\\u{1F600}"');
    });

    it("escapes CJK characters", () => {
        expect(run('"中文"')).toBe('"\\u4E2D\\u6587"');
    });

    it("leaves identifiers and keywords alone", () => {
        expect(run("var x = 1; x")).toBe("var x = 1; x");
    });

    it("preserves regex literals verbatim", () => {
        expect(run("/[abc]/.test('x')")).toBe("/[abc]/.test('x')");
    });

    it("preserves comments verbatim", () => {
        expect(run("// 中文 comment\n1")).toBe("// 中文 comment\n1");
        expect(run("/* 中文 */ 1")).toBe("/* 中文 */ 1");
    });
});

describe("escapeNonAsciiInStringLiterals — tricky cases", () => {
    it("handles backslash escapes inside a string", () => {
        expect(run('"a\\"中b"')).toBe('"a\\"\\u4E2Db"');
    });

    it("handles apostrophe inside a double-quoted string", () => {
        expect(run('"it\'s café"')).toBe('"it\'s caf\\u00E9"');
    });

    it("handles template literal substitutions as expression context", () => {
        const out = run("`a中${1 + 2}b文`");
        expect(out).toBe("`a\\u4E2D${1 + 2}b\\u6587`");
    });

    it("handles a regex with a / inside a character class", () => {
        expect(run("/[/]/.test('x')")).toBe("/[/]/.test('x')");
    });

    it("handles multi-line template literals", () => {
        const src = "`café\nlatte`";
        expect(run(src)).toBe("`caf\\u00E9\nlatte`");
    });

    it("handles ASCII printables (no escape)", () => {
        const src = "`a\tb\nc`";
        expect(run(src)).toBe("`a\tb\nc`");
    });
});

describe("escapeNonAsciiInStringLiterals — fallback path", () => {
    it("returns ok:false with a clear message on unbalanced quotes", () => {
        const r = escapeNonAsciiInStringLiterals('"unterminated');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/unbalanced|unterminated/i);
    });

    it("returns ok:false on unterminated template literal", () => {
        const r = escapeNonAsciiInStringLiterals("`unterminated");
        expect(r.ok).toBe(false);
    });
});
