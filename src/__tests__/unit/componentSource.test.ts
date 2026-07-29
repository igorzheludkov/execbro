import { describe, it, expect } from "@jest/globals";
import {
    buildSelectionProbeExpression,
    buildDebugStackHarvestExpression,
} from "../../core/componentSource.js";

describe("buildSelectionProbeExpression", () => {
    const expr = buildSelectionProbeExpression();

    it("looks up the React DevTools hook and iterates renderer ids", () => {
        expect(expr).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
        expect(expr).toContain("getFiberRoots");
        expect(expr).toContain("hook.renderers");
        expect(expr).not.toMatch(/getFiberRoots\(\s*2\s*\)/);
    });

    it("searches for InspectorPanel", () => {
        expect(expr).toContain("InspectorPanel");
    });

    it("compares by object identity against the global stash", () => {
        expect(expr).toContain("__execbro_lastInspected");
        expect(expr).toContain("!==");
    });

    it("does not measure anything (must stay cheap per tick)", () => {
        expect(expr).not.toContain("measureInWindow");
    });

    it("is Hermes-safe: no arrow functions, template literals or optional chaining", () => {
        expect(expr).not.toContain("=>");
        expect(expr).not.toContain("?.");
        expect(expr).not.toContain("`");
    });

    it("is ASCII-only", () => {
        // eslint-disable-next-line no-control-regex
        expect(/^[\x00-\x7F]*$/.test(expr)).toBe(true);
    });
});

describe("buildDebugStackHarvestExpression", () => {
    const expr = buildDebugStackHarvestExpression(210, 450);

    it("evaluates to a Promise", () => {
        expect(expr.trim().startsWith("new Promise(")).toBe(true);
    });

    it("interpolates the target coordinates", () => {
        expect(expr).toContain("210");
        expect(expr).toContain("450");
    });

    it("reads _debugStack and falls back to _debugSource", () => {
        expect(expr).toContain("_debugStack");
        expect(expr).toContain("_debugSource");
    });

    it("walks the return chain", () => {
        expect(expr).toContain(".return");
    });

    it("measures host fibers to hit-test", () => {
        expect(expr).toContain("measureInWindow");
    });

    it("handles Fabric publicInstance and string-typed host fibers", () => {
        expect(expr).toContain("publicInstance");
        expect(expr).toMatch(/typeof\s+\w+(\.\w+)*\s*===\s*['"]string['"]/);
    });

    it("defaults the ancestor cap to 8 and honours an override", () => {
        expect(buildDebugStackHarvestExpression(1, 2)).toContain("8");
        expect(buildDebugStackHarvestExpression(1, 2, 3)).toContain("maxAncestors = 3");
    });

    it("is Hermes-safe and ASCII-only", () => {
        expect(expr).not.toContain("=>");
        expect(expr).not.toContain("?.");
        // eslint-disable-next-line no-control-regex
        expect(/^[\x00-\x7F]*$/.test(expr)).toBe(true);
    });
});
