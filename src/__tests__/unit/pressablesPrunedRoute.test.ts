import { describe, it, expect, jest } from "@jest/globals";

/**
 * Opus benchmark: tap({ testID: "place-order" }) failed while Checkout was not the
 * focused route. The fiber search skips hidden scenes, so the miss looked the same
 * as a typo. It now names the unfocused route whose subtree holds the testID.
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

describe("a testID on an unfocused route", () => {
    const tree = () =>
        fiber({}, "View", [
            fiber({ focused: true, route: { name: "Account" } }, { name: "Screen" } as unknown as string, [
                fiber({ testID: "account-signout", onPress: () => {} }, "View")
            ]),
            fiber({ focused: false, route: { name: "Checkout" } }, { name: "Screen" } as unknown as string, [
                fiber({}, "View", [fiber({ testID: "place-order", onPress: () => {} }, "View")])
            ])
        ]);

    it("names the route that holds the pruned testID", async () => {
        const out = await search({ testID: "place-order" }, tree());

        expect(out.existsInTree).toBe(false);
        expect(out.prunedRoute).toBe("Checkout");
    });

    it("names no route for a testID that exists nowhere", async () => {
        const out = await search({ testID: "nope" }, tree());

        expect(out.prunedRoute).toBeUndefined();
    });
});
