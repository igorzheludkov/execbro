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
        return eval(expr) as {
            found: boolean;
            candidates?: Array<{ component: string | null }>;
            allInputs?: Array<{ component: string | null }>;
        };
    };

    it("still reports the wrapper as the field's name", () => {
        // The sole mounted input resolves even untargeted and unfocused, so the
        // field list comes back as `allInputs` on the hit rather than as the
        // candidate list of a miss.
        const r = run(buildInputExpression({ kind: "find" }));
        expect(r.allInputs?.[0].component).toBe("InputField");
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

/**
 * Resolution when the screen offers no real choice — the two shapes behind the
 * 2026-08-10 input_text failures: a duplicate mount left behind by a navigation
 * stack, and a lone unfocused field.
 */
describe("resolving without a real choice", () => {
    const field = (props: Record<string, unknown>, nativeTag = 1) => {
        const host = {
            type: "RCTSinglelineTextInputView",
            memoizedProps: props,
            stateNode: { isFocused: () => false, __nativeTag: nativeTag },
            return: null as unknown,
            child: null,
            sibling: null as unknown
        };
        const owner = {
            type: { displayName: "Composer" },
            memoizedProps: { ...props, onChangeText: () => {} },
            stateNode: null,
            return: null as unknown,
            child: host as unknown,
            sibling: null as unknown
        };
        host.return = owner;
        return owner;
    };

    const run = (expr: string, ...fields: ReturnType<typeof field>[]) => {
        const root = { type: { displayName: "Screen" }, memoizedProps: {}, stateNode: null, return: null, child: null as unknown, sibling: null };
        root.child = fields[0];
        for (let i = 0; i < fields.length; i++) {
            fields[i].return = root;
            fields[i].sibling = fields[i + 1] ?? null;
        }
        const g = globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown; global?: unknown };
        g.global = globalThis;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            renderers: new Map([[1, {}]]),
            getFiberRoots: () => new Set([{ current: root }])
        };
        // eslint-disable-next-line no-eval
        return eval(expr) as { found: boolean; ambiguous?: boolean; nativeTag: number | null; reason?: string };
    };

    const dup = { testID: "message-text-input", placeholder: "내용을 입력해주세요.", value: "" };

    it("takes the later of two identical matches instead of refusing", () => {
        // A screen kept mounted under its own re-push: same testID, same
        // placeholder, same value, and only the later one is on screen.
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "message-text-input" }),
            field(dup, 11),
            field(dup, 22)
        );
        expect(r.found).toBe(true);
        expect(r.nativeTag).toBe(22);
    });

    it("refuses when the matches differ only in the text they hold", () => {
        // Different values are a real difference the caller can act on, and one
        // of the two may be a live draft — not a call to guess.
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "message-text-input" }),
            field({ ...dup, value: "draft" }),
            field(dup)
        );
        expect(r.ambiguous).toBe(true);
    });

    it("still refuses when the matches are distinguishable", () => {
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "message-text-input" }),
            field({ ...dup, placeholder: "Subject" }),
            field({ ...dup, placeholder: "Body" })
        );
        expect(r.found).toBe(false);
        expect(r.ambiguous).toBe(true);
    });

    it("resolves the sole mounted input when nothing is focused and nothing was targeted", () => {
        const r = run(buildInputExpression({ kind: "find" }), field({ placeholder: "搜索", value: "" }));
        expect(r.found).toBe(true);
    });

    it("still reports no focus when there is more than one input to choose from", () => {
        const r = run(
            buildInputExpression({ kind: "find" }),
            field({ placeholder: "Email" }),
            field({ placeholder: "Password" })
        );
        expect(r.found).toBe(false);
        expect(r.reason).toContain("no focused TextInput");
    });
});

/**
 * Two 2026-08-22 bad_target buckets, executed against a synthetic tree: a
 * component target naming the RN primitive (12/wk of the 32 component misses),
 * and a testID off by a prefix (26/wk).
 *
 * Only the first changes what resolves, and only when the filter matched
 * NOTHING — reproduced live on device the same day, `component: "TextInput"`
 * matched all six mounted inputs on an app whose wrappers contain that
 * substring, and that answer is correct. The testID change is message-only.
 */
describe("recovering from a target that cannot match", () => {
    const field = (props: Record<string, unknown>, component = "Composer", nativeTag = 1) => {
        const host = {
            type: "RCTSinglelineTextInputView",
            memoizedProps: props,
            stateNode: { isFocused: () => false, __nativeTag: nativeTag },
            return: null as unknown,
            child: null,
            sibling: null as unknown
        };
        const owner = {
            type: { displayName: component },
            memoizedProps: { ...props, onChangeText: () => {} },
            stateNode: null,
            return: null as unknown,
            child: host as unknown,
            sibling: null as unknown
        };
        host.return = owner;
        return owner;
    };

    const run = (expr: string, ...fields: ReturnType<typeof field>[]) => {
        const root = { type: { displayName: "Form" }, memoizedProps: {}, stateNode: null, return: null, child: null as unknown, sibling: null };
        root.child = fields[0];
        for (let i = 0; i < fields.length; i++) {
            fields[i].return = root;
            fields[i].sibling = fields[i + 1] ?? null;
        }
        const g = globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown; global?: unknown };
        g.global = globalThis;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            renderers: new Map([[1, {}]]),
            getFiberRoots: () => new Set([{ current: root }])
        };
        // eslint-disable-next-line no-eval
        return eval(expr) as { found: boolean; ambiguous?: boolean; nativeTag: number | null; reason?: string };
    };

    it('resolves the sole mounted input when component is the RN primitive "TextInput"', () => {
        // The app names its wrapper SearchBar, so the substring filter selects
        // nothing and the caller was told the field was not there.
        const r = run(buildInputExpression({ kind: "find" }, { component: "TextInput" }), field({ placeholder: "Search" }, "SearchBar"));
        expect(r.found).toBe(true);
    });

    it('still offers the full match list when authored wrappers do contain "TextInput"', () => {
        // Reproduced live 2026-08-22: six mounted inputs, all six matched, and
        // the ambiguous candidate list is the useful answer. The fall-through
        // must not swallow it.
        const r = run(
            buildInputExpression({ kind: "find" }, { component: "TextInput" }),
            field({ placeholder: "Amount" }, "StyledTextInput"),
            field({ placeholder: "Cents" }, "InternalTextInput"),
            field({ placeholder: "Name" }, "LabeledField")
        );
        expect(r.found).toBe(false);
        expect(r.ambiguous).toBe(true);
    });

    it('still refuses to guess for component "TextInput" when several inputs are mounted', () => {
        const r = run(
            buildInputExpression({ kind: "find" }, { component: "TextInput" }),
            field({ placeholder: "Email" }, "EmailField"),
            field({ placeholder: "Password" }, "PasswordField")
        );
        expect(r.found).toBe(false);
        expect(r.reason).toContain("no focused TextInput");
    });

    it("never falls through when a testID was given alongside the primitive name", () => {
        // The testID branch owns the resolution; falling back to focus-or-single
        // here would resolve a field the caller never described.
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "nope", component: "TextInput" }),
            field({ placeholder: "Search", testID: "search" }, "SearchBar")
        );
        expect(r.found).toBe(false);
        expect(r.reason).toContain("no TextInput matched that target");
    });

    it("still matches an authored composite name exactly", () => {
        const r = run(
            buildInputExpression({ kind: "find" }, { component: "PasswordField" }),
            field({ placeholder: "Email" }, "EmailField", 11),
            field({ placeholder: "Password" }, "PasswordField", 22)
        );
        expect(r.found).toBe(true);
        expect(r.nativeTag).toBe(22);
    });

    it("offers the closest mounted testID as a did-you-mean, before anything else", () => {
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "search-input" }),
            field({ testID: "church-search-list-search-input", placeholder: "Search" }, "SearchBar")
        );
        expect(r.found).toBe(false);
        // Telemetry truncates the message at 200 chars, so the actionable half
        // has to come first.
        expect(r.reason?.startsWith('did you mean testID "church-search-list-search-input" (index 0)?')).toBe(true);
    });

    it("catches a testID that is one character short of a mounted one", () => {
        // Reproduced live 2026-08-22: testID "name-inpu" returned the bare miss.
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "name-inpu" }),
            field({ testID: "name-input", placeholder: "Name" }, "LabeledField")
        );
        expect(r.reason).toContain("did you mean");
        expect(r.reason).toContain("name-input");
    });

    it("does not invent a did-you-mean for an unrelated testID", () => {
        const r = run(
            buildInputExpression({ kind: "find" }, { testID: "search-input" }),
            field({ testID: "totally-other", placeholder: "Search" }, "SearchBar")
        );
        expect(r.reason).toContain("no TextInput matched that target");
    });
});

/**
 * The pin: `nativeTag` carried back into the query after a resolve, so the ops
 * that follow a write address the field the write landed in rather than
 * re-deriving it from a predicate the write just destroyed.
 *
 * Live sequence 2026-08-22: set cents-input to "42.50" by testID, then
 * {textMatch:"42.50", text:"99.00", replace:true} — the field ends up holding
 * "99.00" and the tool reports "no TextInput matched that target".
 */
describe("pinning a resolved field by native tag", () => {
    const field = (props: Record<string, unknown>, nativeTag: number | null, stateNode?: object) => {
        const host = {
            type: "RCTSinglelineTextInputView",
            memoizedProps: props,
            stateNode: stateNode ?? { isFocused: () => false, __nativeTag: nativeTag },
            return: null as unknown,
            child: null,
            sibling: null as unknown
        };
        const owner = {
            type: { displayName: "Stepper" },
            memoizedProps: { ...props, onChangeText: () => {} },
            stateNode: null,
            return: null as unknown,
            child: host as unknown,
            sibling: null as unknown
        };
        host.return = owner;
        return owner;
    };

    const run = (expr: string, ...fields: ReturnType<typeof field>[]) => {
        const root = { type: { displayName: "Form" }, memoizedProps: {}, stateNode: null, return: null, child: null as unknown, sibling: null };
        root.child = fields[0];
        for (let i = 0; i < fields.length; i++) {
            fields[i].return = root;
            fields[i].sibling = fields[i + 1] ?? null;
        }
        const g = globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown; global?: unknown };
        g.global = globalThis;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            renderers: new Map([[1, {}]]),
            getFiberRoots: () => new Set([{ current: root }])
        };
        // eslint-disable-next-line no-eval
        return eval(expr) as { found: boolean; nativeTag: number | null; value: string | null; reason?: string };
    };

    const cents = () => field({ value: "42.50", placeholder: "Cents" }, 22);
    const other = () => field({ value: "0.00", placeholder: "Dollars" }, 33);

    it("resolves the pinned field after the write killed the predicate that found it", () => {
        const a = cents();
        const b = other();

        // Before the write, the predicate is live and resolves on its own.
        expect(run(buildInputExpression({ kind: "read" }, { textMatch: "42.50" }), a, b).found).toBe(true);

        // The write lands: the value the caller targeted no longer exists.
        const writeValue = (f: { memoizedProps: object }, v: string) => {
            (f.memoizedProps as Record<string, unknown>).value = v;
        };
        writeValue(a, "99.00");
        writeValue(a.child as { memoizedProps: object }, "99.00");

        // The identical query is now a guaranteed miss — this is the 83/wk bucket.
        expect(run(buildInputExpression({ kind: "read" }, { textMatch: "42.50" }), a, b).found).toBe(false);

        // The pin still addresses the same field, and reads back what landed.
        const r = run(buildInputExpression({ kind: "read" }, { textMatch: "42.50", nativeTag: 22 }), a, b);
        expect(r.found).toBe(true);
        expect(r.nativeTag).toBe(22);
        expect(r.value).toBe("99.00");
    });

    it("falls back to the predicate when the pinned tag is gone", () => {
        // A genuine remount: the tag no longer exists, and the rest of the query
        // is the only thing left to resolve with. This fall-through is the whole
        // safety net — there is deliberately no other fallback.
        const r = run(buildInputExpression({ kind: "read" }, { textMatch: "0.00", nativeTag: 999 }), cents(), other());
        expect(r.found).toBe(true);
        expect(r.nativeTag).toBe(33);
    });

    it("ignores an index carried over from the original query once the tag pinned a field", () => {
        // The index chose among the PREDICATE's matches. Applied to the single
        // pinned match it would invent "index 3 is out of range" on a call that
        // had just resolved correctly.
        const r = run(buildInputExpression({ kind: "read" }, { textMatch: "42.50", nativeTag: 22, index: 3 }), cents(), other());
        expect(r.found).toBe(true);
        expect(r.nativeTag).toBe(22);
    });

    it("still honours the index on the fall-through, where the predicate is matching again", () => {
        const r = run(
            buildInputExpression({ kind: "read" }, { textMatch: "0", nativeTag: 999, index: 9 }),
            cents(),
            other()
        );
        expect(r.found).toBe(false);
        expect(r.reason).toContain("is out of range");
    });

    it("degrades to today's behaviour on a host that exposes no native tag", () => {
        // Verified live on RN 0.85 New Architecture that __eb_pub does expose
        // __nativeTag, so this is the rare path — but it must be silent, not an
        // error, and it must still resolve through the predicate.
        const noTag = field({ value: "42.50", placeholder: "Cents" }, null, { isFocused: () => false });
        const r = run(buildInputExpression({ kind: "read" }, { textMatch: "42.50", nativeTag: 22 }), noTag);
        expect(r.found).toBe(true);
        expect(r.nativeTag).toBe(null);
    });
});
