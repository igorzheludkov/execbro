import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The fiber search matches on `typeof props.onPress === 'function'`, in six
 * separate copies of the same condition. An element wired only for long press
 * — a Pressable with onLongPress and no onPress — is therefore invisible to it,
 * so `tap({testID, duration})` could never resolve the very elements long press
 * exists for.
 *
 * The widening is gated on the caller asking for a hold. Unconditionally
 * accepting onLongPress would make a plain `tap` confidently resolve elements
 * whose short press does nothing at all.
 *
 * These tests drive the generated JS through a fake fiber tree, so they assert
 * what the app would actually evaluate rather than the shape of the string.
 */

const evaluated: string[] = [];
let evalResult: unknown = null;

jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    executeInApp: async (expression: string) => {
        evaluated.push(expression);
        return { success: true, result: JSON.stringify(evalResult) };
    },
    delay: async () => {}
}));

const { pressElement } = await import("../../core/pressables.js");

/** Minimal fiber node: only what the injected walker actually reads. */
function fiber(props: Record<string, unknown>, type = "View", children: unknown[] = []): unknown {
    const node: Record<string, unknown> = {
        type,
        memoizedProps: props,
        stateNode: { measureInWindow: (cb: (...a: number[]) => void) => cb(10, 20, 100, 50) },
        child: null,
        sibling: null,
        return: null
    };
    let prev: Record<string, unknown> | null = null;
    for (const c of children as Record<string, unknown>[]) {
        c.return = node;
        if (prev) prev.sibling = c;
        else node.child = c;
        prev = c;
    }
    return node;
}

/**
 * pressElement works in two passes against the app: the first walks the tree and
 * dispatches measureInWindow, the second reads the measurements back off
 * globalThis. Both are run here against one shared stub so the state carries
 * between them exactly as it does in the app.
 */
async function search(
    options: Parameters<typeof pressElement>[0],
    root: unknown
): Promise<Record<string, unknown>> {
    evaluated.length = 0;
    evalResult = { dispatched: 1 };
    await pressElement(options);

    const globalThisStub: Record<string, unknown> = {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: {
            getFiberRoots: () => new Set([{ current: root }]),
            renderers: new Map()
        }
    };
    let last: unknown = null;
    for (const expression of evaluated) {
        const fn = new Function("globalThis", `return (${expression.trim()});`);
        last = fn(globalThisStub);
    }
    return typeof last === "string" ? JSON.parse(last) : (last as Record<string, unknown>);
}

describe("fiber search and onLongPress", () => {
    beforeEach(() => {
        evaluated.length = 0;
    });

    it("ignores a long-press-only element for an ordinary tap", async () => {
        const root = fiber({}, "View", [
            fiber({ testID: "row-3", onLongPress: () => {} }, "View", [
                fiber({ children: "Row 3" }, "Text")
            ])
        ]);

        const out = await search({ testID: "row-3" }, root);

        // The gate: a plain tap must not start resolving elements whose short
        // press does nothing.
        expect(out.needsNativeTap).toBeUndefined();
        expect(out.error).toBeDefined();
    });

    it("finds a long-press-only element when a hold was requested", async () => {
        const root = fiber({}, "View", [
            fiber({ testID: "row-3", onLongPress: () => {} }, "View", [
                fiber({ children: "Row 3" }, "Text")
            ])
        ]);

        const out = await search({ testID: "row-3", longPress: true }, root);

        expect(out.needsNativeTap).toBe(true);
        expect(out.hasLongPress).toBe(true);
    });

    it("reports an ordinary button as having no long-press handler", async () => {
        const root = fiber({}, "View", [
            fiber({ testID: "save", onPress: () => {} }, "View", [
                fiber({ children: "Save" }, "Text")
            ])
        ]);

        const out = await search({ testID: "save", longPress: true }, root);

        expect(out.needsNativeTap).toBe(true);
        // Not an error — the hold still gets delivered. This is what lets the
        // caller be told the element has no onLongPress instead of guessing.
        expect(out.hasLongPress).toBe(false);
    });

    it("still finds ordinary pressables when a hold was requested", async () => {
        const root = fiber({}, "View", [
            fiber({ onPress: () => {} }, "View", [fiber({ children: "Save" }, "Text")])
        ]);

        const out = await search({ text: "Save", longPress: true }, root);

        expect(out.needsNativeTap).toBe(true);
    });
});
