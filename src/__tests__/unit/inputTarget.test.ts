import { describe, expect, it } from "@jest/globals";
import { buildInputExpression } from "../../core/inputTarget.js";

describe("buildInputExpression", () => {
    it("returns a parseable IIFE", () => {
        const expr = buildInputExpression({ kind: "find" });
        expect(expr.trim()).toMatch(/^\(\(\)\s*=>\s*\{/);
        expect(expr.trim()).toMatch(/\}\)\(\)$/);
    });

    it("walks every fiber root, not just the first", () => {
        const expr = buildInputExpression({ kind: "find" });
        // The old walkers did `if (roots.length > 0) { root = roots[0]; break; }`,
        // which hid a focused input living under a second root (modal/portal).
        expect(expr).not.toMatch(/roots\[0\]/);
        expect(expr).toContain("getFiberRoots");
        expect(expr).toContain("allRoots");
    });

    it("resolves the public instance for Fabric and Paper stateNode shapes", () => {
        const expr = buildInputExpression({ kind: "find" });
        expect(expr).toContain("canonical.publicInstance");
        // Paper exposes the instance as stateNode itself. A Fabric-only read makes
        // old-arch apps report "no focused TextInput" while a field IS focused.
        expect(expr).toMatch(/return sn;/);
    });

    it("recognises all three host input types", () => {
        const expr = buildInputExpression({ kind: "find" });
        expect(expr).toContain("RCTSinglelineTextInputView");
        expect(expr).toContain("RCTMultilineTextInputView");
        expect(expr).toContain("AndroidTextInput");
    });

    it("targets by testID when a query is given", () => {
        const expr = buildInputExpression({ kind: "focus" }, { testID: "email-input" });
        expect(expr).toContain('"email-input"');
        expect(expr).toContain("wantTestID");
    });

    it("falls back to the focused input when no query is given", () => {
        const expr = buildInputExpression({ kind: "focus" });
        expect(expr).toContain("isFocused");
        expect(expr).toContain("wantTestID = null");
    });

    it("embeds the value as a JSON literal for setValue", () => {
        const tricky = 'a"b\\c';
        const expr = buildInputExpression({ kind: "setValue", value: tricky });
        expect(expr).toContain(JSON.stringify(tricky));
    });

    it("writes and clears through onChangeText", () => {
        expect(buildInputExpression({ kind: "setValue", value: "x" })).toContain("onChangeText");
        expect(buildInputExpression({ kind: "clear" })).toContain('onChangeText("")');
    });

    it("focuses and blurs through the public instance", () => {
        expect(buildInputExpression({ kind: "focus" })).toContain(".focus()");
        expect(buildInputExpression({ kind: "blur" })).toContain(".blur()");
    });

    it("offers candidate testIDs when the target is not found", () => {
        const expr = buildInputExpression({ kind: "focus" }, { testID: "nope" });
        expect(expr).toContain("candidates");
    });

    it("explains how to fix a missing focus rather than just naming it", () => {
        const expr = buildInputExpression({ kind: "find" });
        expect(expr).toContain("no focused TextInput");
        expect(expr).toContain("testID");
    });

    it("keeps clear falling back to publicInstance.clear for uncontrolled inputs", () => {
        expect(buildInputExpression({ kind: "clear" })).toContain(".clear()");
    });
});
