import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * A Switch carries onValueChange and no onPress, so the fiber search saw
 * nothing: the only way to flip one was to guess an x from a screenshot and
 * pair it with the row label's y — and a guess that lands on the neighbouring
 * row is indistinguishable from a correct toggle in tap's pixel diff.
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

describe("fiber search and Switch elements", () => {
    beforeEach(() => {
        evaluated.length = 0;
    });

    const switchTree = (value: boolean) =>
        fiber({}, "View", [
            fiber({ children: "Push notifications" }, "Text"),
            fiber({ testID: "settings-push", onValueChange: () => {}, value }, "Switch", [
                fiber({}, "RCTSwitch")
            ])
        ]);

    it("resolves a switch by testID even though it has no onPress", async () => {
        const out = await search({ testID: "settings-push" }, switchTree(false));

        expect(out.needsNativeTap).toBe(true);
        expect(out.switchValue).toBe(false);
    });

    it("reports the value the caller is about to change", async () => {
        const out = await search({ testID: "settings-push" }, switchTree(true));

        expect(out.switchValue).toBe(true);
    });

    it("resolves a Switch that carries no handler at all", async () => {
        // Verified on device (RN 0.83): the app renders <Switch value={x} /> and
        // drives it from a gesture-handler row, so the fiber has a value and
        // nothing else. Keying off onValueChange left exactly this one invisible.
        const root = fiber({}, "View", [
            fiber({ children: "Sponsor" }, "Text"),
            fiber({ value: false }, { name: "Switch" } as unknown as string, [fiber({}, "RCTSwitch")])
        ]);

        const out = await search({ component: "Switch" }, root);

        expect(out.needsNativeTap).toBe(true);
        expect(out.switchValue).toBe(false);
    });

    it("leaves switchValue null for an ordinary button", async () => {
        const root = fiber({}, "View", [
            fiber({ testID: "save", onPress: () => {} }, "View", [fiber({ children: "Save" }, "Text")])
        ]);

        const out = await search({ testID: "save" }, root);

        expect(out.needsNativeTap).toBe(true);
        expect(out.switchValue).toBeNull();
    });
});
