import { describe, expect, it } from "@jest/globals";
import {
    buildFindFocusedInputExpression,
    buildClearFocusedInputExpression,
    buildDismissKeyboardExpression
} from "../../core/focusedInput.js";

describe("buildFindFocusedInputExpression", () => {
    it("includes the React DevTools hook and fiber-root walk", () => {
        const expr = buildFindFocusedInputExpression();
        expect(expr).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
        expect(expr).toContain("getFiberRoots");
        expect(expr).toContain("RCTSinglelineTextInputView");
        expect(expr).toContain("RCTMultilineTextInputView");
    });

    it("handles string-type host fibers (Fabric)", () => {
        const expr = buildFindFocusedInputExpression();
        // The Fabric path requires recognizing host fibers whose `type` is a string,
        // not a class with displayName. The getName helper applies a typeof === "string" check.
        expect(expr).toMatch(/typeof\s+\w+\s*===\s*['"]string['"]/);
    });

    it("climbs .return to find a fiber with onChangeText", () => {
        const expr = buildFindFocusedInputExpression();
        expect(expr).toContain("onChangeText");
        expect(expr).toContain(".return");
    });

    it("returns a parseable expression (IIFE)", () => {
        const expr = buildFindFocusedInputExpression();
        expect(expr.trim()).toMatch(/^\(\(\)\s*=>\s*\{/);
        expect(expr.trim()).toMatch(/\}\)\(\)$/);
    });
});

describe("buildClearFocusedInputExpression", () => {
    it("calls onChangeText('') on the controlled fiber", () => {
        const expr = buildClearFocusedInputExpression();
        expect(expr).toContain(`onChangeText("")`);
    });

    it("falls back to publicInstance.clear when no onChangeText ancestor", () => {
        const expr = buildClearFocusedInputExpression();
        expect(expr).toContain("pub.clear()");
        expect(expr).toContain(`via: "publicInstance"`);
    });

    it("returns cleared:true with the via field on success", () => {
        const expr = buildClearFocusedInputExpression();
        expect(expr).toMatch(/cleared:\s*true,\s*via:\s*"onChangeText"/);
    });

    it("returns cleared:false with reason when nothing focused", () => {
        const expr = buildClearFocusedInputExpression();
        expect(expr).toContain(`cleared: false, reason: "no focused TextInput"`);
    });
});

describe("buildDismissKeyboardExpression", () => {
    it("calls publicInstance.blur()", () => {
        const expr = buildDismissKeyboardExpression();
        expect(expr).toContain("pub.blur()");
    });

    it("returns dismissed:false with reason when nothing focused", () => {
        const expr = buildDismissKeyboardExpression();
        expect(expr).toContain(`dismissed: false, reason: "no focused TextInput"`);
    });
});
