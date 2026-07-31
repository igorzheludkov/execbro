import { describe, it, expect } from "@jest/globals";
import { buildEvaluationSource } from "../../core/executor.js";

describe("buildEvaluationSource", () => {
    it("puts the polyfill first, then the context, then the caller's expression", () => {
        const src = buildEvaluationSource("state.auth");
        expect(src.indexOf("var global =")).toBeLessThan(src.indexOf("var store ="));
        expect(src.indexOf("var store =")).toBeLessThan(src.lastIndexOf("state.auth"));
        expect(src.endsWith("state.auth")).toBe(true);
    });

    it("declares context bindings with var so the caller's expression can see them", () => {
        const src = buildEvaluationSource("1");
        expect(src).toContain("var store =");
        expect(src).toContain("var state =");
        expect(src).not.toContain("const store");
    });

    it("does not wrap the caller's expression", () => {
        // PR #5 (merged 2026-03-02) reverted blanket IIFE wrapping: it wrapped
        // without a `return`, so every result came back undefined, and tools
        // building their own IIFE were double-wrapped.
        const src = buildEvaluationSource("2 + 2");
        expect(src).not.toContain("(function(){ 2 + 2 })()");
        expect(src.endsWith("2 + 2")).toBe(true);
    });

    it("is stable across calls so the preamble is built once", () => {
        expect(buildEvaluationSource("1")).toBe(buildEvaluationSource("1"));
    });
});
