import { describe, it, expect } from "@jest/globals";
// @ts-expect-error — build-time script, deliberately unpublished, so it has no types.
import { findEatenEscapes } from "../../../scripts/check-injected-js.mjs";

/**
 * The hazard this guards: injected JavaScript is authored inside template literals
 * and parsed twice, first by TypeScript and then by Hermes. TypeScript resolves
 * escape sequences on the first pass, so `\d` reaches the device as a bare `d` —
 * the regex still compiles, still matches, and now means something else. There is
 * no build error and no runtime error, only a screen read that quietly stops
 * matching. Every injected source in this repo writes `\\d` for that reason.
 */
describe("findEatenEscapes", () => {
    it("flags a regex escape that the template literal will eat", () => {
        const found = findEatenEscapes("const x = `var COUNT = /^\\d{1,3}$/;`;");
        expect(found).toHaveLength(1);
        expect(found[0].sequence).toBe("\\d");
    });

    it("accepts the doubled form that survives to the device", () => {
        expect(findEatenEscapes("const x = `var COUNT = /^\\\\d{1,3}$/;`;")).toHaveLength(0);
    });

    it("leaves legitimate string escapes alone", () => {
        expect(findEatenEscapes('const x = `var s = "a\\nb\\tc\\"d";`;')).toHaveLength(0);
    });

    it("ignores regexes in ordinary code outside any template literal", () => {
        // The overwhelming majority of the codebase; this must stay silent.
        expect(findEatenEscapes("const re = /^\\d+$/;\nconst s = 'a\\db';")).toHaveLength(0);
    });

    it("returns to ordinary code inside a ${} interpolation", () => {
        // An interpolated expression is TypeScript, not injected source.
        expect(findEatenEscapes("const x = `prefix ${ /^\\d+$/.source } suffix`;")).toHaveLength(0);
    });

    it("resumes checking after an interpolation closes", () => {
        const found = findEatenEscapes("const x = `${a} tail /^\\w+$/`;");
        expect(found).toHaveLength(1);
        expect(found[0].sequence).toBe("\\w");
    });

    it("handles nested braces inside an interpolation without losing its place", () => {
        const found = findEatenEscapes("const x = `${ f({ a: 1 }) } /^\\s+$/`;");
        expect(found).toHaveLength(1);
        expect(found[0].sequence).toBe("\\s");
    });

    it("skips comments and quoted strings that contain backticks", () => {
        // A backtick in prose ended the template literal for real once; here it must
        // not fool the scanner into thinking a template started.
        const src = "// see `occludes` for the inverse\nconst s = 'a `b` c';\nconst re = /^\\d$/;";
        expect(findEatenEscapes(src)).toHaveLength(0);
    });

    it("reports the line the escape is on", () => {
        expect(findEatenEscapes("const a = 1;\nconst b = 2;\nconst x = `/^\\d$/`;")[0].line).toBe(3);
    });

    it("finds every occurrence, not just the first", () => {
        expect(findEatenEscapes("const x = `/^\\d$/ and /^\\w$/ and /^\\s$/`;")).toHaveLength(3);
    });
});
