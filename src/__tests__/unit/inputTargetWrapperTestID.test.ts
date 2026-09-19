import { afterEach, describe, expect, it } from "@jest/globals";
import { buildInputExpression } from "../../core/inputTarget.js";

/**
 * Behavioural tests for resolving an input by a testID that sits on its WRAPPER.
 *
 * The other inputTarget suite asserts on the expression text, which cannot see
 * this at all: the question is which fiber a given tree resolves to, so these
 * run the expression against trees shaped like the ones the misses came from.
 *
 * The shape: a custom <Input testID="login-password"> spreads style and layout
 * onto a container View and passes only value/onChangeText down to the real
 * TextInput, so the testID the app author wrote is nowhere near the host fiber.
 */

type Fiber = {
    type: unknown;
    memoizedProps?: Record<string, unknown>;
    stateNode?: unknown;
    child?: Fiber | null;
    sibling?: Fiber | null;
    return?: Fiber | null;
};

function node(type: unknown, props: Record<string, unknown>, children: Fiber[] = []): Fiber {
    const f: Fiber = { type, memoizedProps: props, child: children[0] ?? null, sibling: null, return: null };
    for (let i = 0; i < children.length; i++) {
        children[i].return = f;
        children[i].sibling = children[i + 1] ?? null;
    }
    return f;
}

/** A mounted TextInput: host fiber under the composite that owns onChangeText. */
function field(opts: { placeholder?: string; testID?: string } = {}): Fiber {
    const props = {
        ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
        ...(opts.testID ? { testID: opts.testID } : {}),
        onChangeText: () => {}
    };
    const host = node("RCTSinglelineTextInputView", props);
    host.stateNode = { canonical: { publicInstance: { __nativeTag: 1, isFocused: () => false } } };
    return node({ name: "TextInput" }, props, [host]);
}

function install(root: Fiber) {
    (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        renderers: new Map([[1, {}]]),
        getFiberRoots: () => new Set([{ current: root }])
    };
}

afterEach(() => {
    delete (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__;
});

async function find(testID: string) {
    const expr = buildInputExpression({ kind: "find" }, { testID });
    return (await new Function(`return (${expr});`)()) as Record<string, unknown>;
}

describe("input targeting by a wrapper's testID", () => {
    it("resolves an input whose testID is on the custom component wrapping it", async () => {
        install(node({ name: "LoginScreen" }, {}, [
            node({ name: "Input" }, { testID: "login-email" }, [
                node("RCTView", {}, [field({ placeholder: "Email" })])
            ]),
            node({ name: "Input" }, { testID: "login-password" }, [
                node("RCTView", {}, [field({ placeholder: "Password" })])
            ])
        ]));
        const r = await find("login-password");
        expect(r.found).toBe(true);
        expect((r as { placeholder?: string }).placeholder).toBe("Password");
    });

    it("refuses a wrapper testID that covers more than one field", async () => {
        // The collision the narrow testID scope exists to prevent: one id above
        // a whole form answers for every field under it, so resolving it would
        // be a coin flip between them.
        install(node({ name: "Form" }, { testID: "payee-form" }, [
            node("RCTView", {}, [field({ placeholder: "Name" }), field({ placeholder: "IBAN" })])
        ]));
        const r = await find("payee-form");
        expect(r.found).toBe(false);
        expect(String(r.reason)).toContain("is on a wrapper around 2");
    });

    it("says the screen has no testIDs at all rather than repeating the target back", async () => {
        install(node({ name: "LoginScreen" }, {}, [
            node("RCTView", {}, [field({ placeholder: "Email" })])
        ]));
        const r = await find("login-input");
        expect(r.found).toBe(false);
        expect(String(r.reason)).toContain("no input on this screen has a testID");
    });

    it("prefers a testID on the input itself over one on an ancestor", async () => {
        install(node({ name: "Wrap" }, { testID: "shared" }, [
            node("RCTView", {}, [field({ placeholder: "Outer" }), field({ placeholder: "Inner", testID: "shared" })])
        ]));
        const r = await find("shared");
        expect(r.found).toBe(true);
        expect((r as { placeholder?: string }).placeholder).toBe("Inner");
    });
});
