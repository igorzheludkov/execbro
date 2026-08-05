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

describe("target disambiguation", () => {
    it("collects every match instead of taking the first", () => {
        const expr = buildInputExpression({ kind: "find" }, { component: "Input" });
        // Silently taking match[0] writes the right text into the wrong field of a
        // form and still verifies clean. Every branch must push, never break.
        expect(expr).toContain("__eb_matches.push");
        expect(expr).not.toMatch(/__eb_host = __eb_inputs\[i\]; break;/);
    });

    it("refuses when several inputs match and no index is given", () => {
        const expr = buildInputExpression({ kind: "find" }, { component: "Input" });
        expect(expr).toContain("ambiguous: true");
        expect(expr).toContain("__eb_matches.length > 1");
    });

    it("selects by index when one is supplied", () => {
        const expr = buildInputExpression({ kind: "find" }, { component: "Input", index: 3 });
        expect(expr).toContain("__eb_index = 3");
    });

    it("rejects an out-of-range index rather than clamping it", () => {
        const expr = buildInputExpression({ kind: "find" }, { component: "Input", index: 99 });
        expect(expr).toContain("is out of range");
    });

    it("describes candidates richly enough to choose between them", () => {
        const expr = buildInputExpression({ kind: "find" }, { testID: "nope" });
        for (const field of ["index:", "component:", "label:", "placeholder:", "value:", "testID:"]) {
            expect(expr).toContain(field);
        }
    });
});

describe("targeting keys", () => {
    it("scopes testID to the host and its owner, never an arbitrary ancestor", () => {
        const expr = buildInputExpression({ kind: "find" }, { testID: "email" });
        // Free climbing picked up a ScrollView's nativeID: on a 7-field form every
        // input answered to testID "7", so one target matched them all.
        expect(expr).toContain("__eb_testIDOf");
        expect(expr).toContain("scope");
        expect(expr).not.toMatch(/for \(var p = hostFiber; p; p = p\.return\)[\s\S]{0,120}mp\.nativeID/);
    });

    it("prefers an explicit testID over a nativeID", () => {
        const expr = buildInputExpression({ kind: "find" }, { testID: "email" });
        expect(expr.indexOf("mp.testID")).toBeLessThan(expr.indexOf("mp2.nativeID"));
    });

    it("filters framework wrappers out of the component name", () => {
        const expr = buildInputExpression({ kind: "find" }, { component: "InputField" });
        // Without the filters every input resolves to TextAncestorContext, which
        // names nothing and matches everything.
        expect(expr).toContain("RN_PRIMITIVES");
        expect(expr).toContain("GENERIC_COMPONENT");
        expect(expr).toContain("TextAncestorContext");
    });

    it("matches the visible field label as well as value and placeholder", () => {
        const expr = buildInputExpression({ kind: "find" }, { textMatch: "First Name" });
        expect(expr).toContain("__eb_labelOf");
        expect(expr).toContain("accessibilityLabel");
    });

    it("never lets an input's own value become its label", () => {
        const expr = buildInputExpression({ kind: "find" }, { textMatch: "x" });
        expect(expr).toMatch(/HOSTS\.indexOf\(__eb_name\(f\.type\)\) !== -1\) return;/);
    });

    it("finds the field wrapper by outermost onChangeText, not a capped climb", () => {
        const expr = buildInputExpression({ kind: "find" }, { component: "FormInput" });
        // Measured on a real form: the wrapper sits 10 levels above the host behind
        // four plain Views, so a 4-composite budget is spent before reaching it and
        // every input resolves to nothing. onChangeText is what distinguishes a
        // field's wrapper from the layout Views around it.
        expect(expr).toContain("__eb_fieldFiber");
        expect(expr).toContain("d < 30");
    });

    it("reads and writes through the innermost composite, skipping host fibers", () => {
        const expr = buildInputExpression({ kind: "setValue", value: "x" });
        expect(expr).toMatch(/if \(typeof p\.type === "string"\) continue;/);
    });

    it("stops descending a text branch once it yields a string", () => {
        const expr = buildInputExpression({ kind: "find" });
        // One label repeats down its Text -> RCTText chain; descending through it
        // renders "Title Title Title *" instead of "Title *".
        expect(expr).toMatch(/parts\.push\(mp\.children\.trim\(\)\);[\s\S]{0,80}return;/);
    });
});

/**
 * These EXECUTE the injected walker against a synthetic fiber tree instead of
 * asserting on its source. The divergence below is invisible to a string
 * check: both walkers read the same filters, so the bug lives in how each one
 * picks from the ancestor chain, not in what the source says.
 *
 * Tree mirrors the shipping-address form the mismatch was found on:
 *   InputField           app wrapper, forwards onChangeText  <- outermost carrier
 *     View               layout
 *       BottomSheetTextInput   library input, carries onChangeText
 *         RCTSinglelineTextInputView   host
 */
describe("component targeting across the field's ancestor chain", () => {
    const buildTree = () => {
        const onChangeText = () => {};
        const node = (name: string, props: object, host = false) => ({
            type: host ? name : { displayName: name },
            memoizedProps: props,
            stateNode: host ? { isFocused: () => false, __nativeTag: 1 } : null,
            return: null as unknown,
            child: null as unknown,
            sibling: null
        });
        const host = node("RCTSinglelineTextInputView", { placeholder: "Robert" }, true);
        const inner = node("BottomSheetTextInput", { onChangeText, value: "Home" });
        const view = node("View", {});
        const wrapper = node("InputField", { onChangeText, value: "Home" });
        host.return = inner; inner.child = host;
        inner.return = view; view.child = inner;
        view.return = wrapper; wrapper.child = view;
        return wrapper;
    };

    const run = (expr: string) => {
        const g = globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown; global?: unknown };
        g.global = globalThis;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            renderers: new Map([[1, {}]]),
            getFiberRoots: () => new Set([{ current: buildTree() }])
        };
        // eslint-disable-next-line no-eval
        return eval(expr) as { found: boolean; candidates?: Array<{ component: string | null }> };
    };

    it("still reports the wrapper as the field's name", () => {
        const r = run(buildInputExpression({ kind: "find" }));
        expect(r.candidates?.[0].component).toBe("InputField");
    });

    it("matches the wrapper name", () => {
        expect(run(buildInputExpression({ kind: "find" }, { component: "InputField" })).found).toBe(true);
    });

    // get_screen_state prints this name for the same field, so an agent can
    // legitimately hold it. Matching only the display name made one of the two
    // names shown on screen unusable as a target.
    it("matches the inner component name get_screen_state prints", () => {
        expect(run(buildInputExpression({ kind: "find" }, { component: "BottomSheetTextInput" })).found).toBe(true);
    });

    it("does not match a component that is nowhere in the chain", () => {
        expect(run(buildInputExpression({ kind: "find" }, { component: "NotOnThisScreen" })).found).toBe(false);
    });
});
