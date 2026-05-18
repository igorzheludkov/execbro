import { describe, expect, it } from "@jest/globals";
import { buildMeasureComponentExpression } from "../../core/measureComponent.js";

describe("buildMeasureComponentExpression", () => {
    it("returns an expression that evaluates to a Promise", () => {
        const expr = buildMeasureComponentExpression("SneakerCard", 0);
        expect(expr.trim()).toMatch(/^new\s+Promise\(/);
    });

    it("includes the React DevTools hook lookup", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
        expect(expr).toContain("getFiberRoots");
    });

    it("iterates renderer ids (does not hardcode renderer id 2)", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain("hook.renderers");
        expect(expr).toContain("renderers.keys()");
        expect(expr).not.toMatch(/getFiberRoots\(\s*2\s*\)/);
    });

    it("handles string-typed host fibers (Fabric)", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toMatch(/typeof\s+\w+\s*===\s*['"]string['"]/);
    });

    it("descends to nearest host descendant when matched fiber lacks measureInWindow", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain("measureInWindow");
        expect(expr).toMatch(/findHost|nearest host|child/);
        expect(expr).toContain("canonical");
        expect(expr).toContain("publicInstance");
    });

    it("Promise-wraps measureInWindow with a 1500ms timeout", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain("measureInWindow(");
        expect(expr).toContain("setTimeout");
        expect(expr).toContain("1500");
        expect(expr).toContain('outcome: "timeout"');
    });

    it("interpolates componentName and index into the expression", () => {
        const expr = buildMeasureComponentExpression("SneakerCard", 3);
        expect(expr).toContain("SneakerCard");
        expect(expr).toContain("3");
    });

    it("escapes single quotes in componentName", () => {
        const expr = buildMeasureComponentExpression("Weird'Name", 0);
        expect(expr).toContain("Weird\\'Name");
    });

    it("returns no_match outcome when index out of range", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain('outcome: "no_match"');
        expect(expr).toContain("no component matched");
    });

    it("returns no_host_descendant outcome when no measurable instance found", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain('outcome: "no_host_descendant"');
        expect(expr).toContain("has no measurable stateNode");
    });

    it("returns measured outcome with x, y, width, height, name, nativeTag", () => {
        const expr = buildMeasureComponentExpression("X", 0);
        expect(expr).toContain('outcome: "measured"');
        expect(expr).toMatch(/x:\s*x/);
        expect(expr).toMatch(/y:\s*y/);
        expect(expr).toMatch(/width:\s*width/);
        expect(expr).toMatch(/height:\s*height/);
        expect(expr).toContain("nativeTag");
    });
});
