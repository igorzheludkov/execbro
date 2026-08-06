import { describe, expect, it, afterEach } from "@jest/globals";
import { buildMeasureComponentExpression } from "../../core/measureComponent.js";

/**
 * Behavioural tests for the injected measure expression.
 *
 * The other measure suite asserts on the expression *text*, which is why a real defect
 * survived it: `measure("ShopHeader")` and `measure("SubTabBar")` returned byte-identical
 * frames and the same nativeTag, because on Fabric a plain RCTView exposes neither
 * `measureInWindow` nor `canonical.publicInstance` — so the search walked past the
 * component's own container and measured whatever deep leaf happened to be reachable. Every
 * string assertion still passed.
 *
 * So these run the expression instead, against a fiber tree shaped like the real one.
 */

type Fiber = {
    type: unknown;
    stateNode?: unknown;
    child?: Fiber | null;
    sibling?: Fiber | null;
};

/** A Fabric host fiber with only a shadow-node handle — no public instance. */
function fabricHost(tag: number, frame: [number, number, number, number], child?: Fiber | null): Fiber {
    return {
        type: "RCTView",
        stateNode: { node: { __tag: tag, __frame: frame }, canonical: { nativeTag: tag } },
        child: child ?? null,
        sibling: null,
    };
}

/** A host fiber that DOES expose a public instance, like RNGestureHandlerButton does. */
function publicHost(tag: number, frame: [number, number, number, number], child?: Fiber | null): Fiber {
    return {
        type: "RNGestureHandlerButton",
        stateNode: {
            node: { __tag: tag },
            canonical: {
                nativeTag: tag,
                publicInstance: {
                    __nativeTag: tag,
                    measureInWindow: (cb: (...a: number[]) => void) => cb(...frame),
                },
            },
        },
        child: child ?? null,
        sibling: null,
    };
}

function composite(name: string, child?: Fiber | null, sibling?: Fiber | null): Fiber {
    return { type: { name }, child: child ?? null, sibling: sibling ?? null };
}

const SHOP_HEADER_FRAME: [number, number, number, number] = [0, 1405, 921, 379];
const SUB_TAB_BAR_FRAME: [number, number, number, number] = [0, 1559, 921, 79];
const TAB_BUTTON_FRAME: [number, number, number, number] = [43, 1559, 153, 79];

/**
 * ShopHeader
 *   View > RCTView(tag 610, the header block)
 *     SubTabBar
 *       View > RCTView(tag 734, the bar)
 *         Pressable > RNGestureHandlerButton(tag 720, ONE tab)
 */
function buildTree(): Fiber {
    const tabButton = publicHost(720, TAB_BUTTON_FRAME);
    const subTabBarHost = fabricHost(734, SUB_TAB_BAR_FRAME, composite("Pressable", tabButton));
    const subTabBar = composite("SubTabBar", composite("View", subTabBarHost));
    const shopHeaderHost = fabricHost(610, SHOP_HEADER_FRAME, subTabBar);
    return composite("ShopHeader", composite("View", shopHeaderHost));
}

function installFakeRuntime(root: Fiber) {
    const g = globalThis as Record<string, unknown>;
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        renderers: new Map([[1, {}]]),
        getFiberRoots: () => new Set([{ current: root }]),
    };
    // The Fabric UIManager: the only way to measure a node that has no public instance.
    g.nativeFabricUIManager = {
        measureInWindow: (
            node: { __tag: number; __frame: [number, number, number, number] },
            cb: (...a: number[]) => void
        ) => cb(...node.__frame),
    };
}

async function runMeasure(name: string, index = 0) {
    const expr = buildMeasureComponentExpression(name, index);
    return (await new Function(`return (${expr});`)()) as Record<string, unknown>;
}

afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.nativeFabricUIManager;
});

describe("measure expression — host resolution on Fabric", () => {
    it("measures the component's OWN container, not a deep measurable descendant", async () => {
        installFakeRuntime(buildTree());
        const r = await runMeasure("ShopHeader");
        expect(r.outcome).toBe("measured");
        expect([r.x, r.y, r.width, r.height]).toEqual(SHOP_HEADER_FRAME);
        expect(r.nativeTag).toBe(610);
    });

    it("gives two different components two different frames", async () => {
        installFakeRuntime(buildTree());
        const header = await runMeasure("ShopHeader");
        installFakeRuntime(buildTree());
        const bar = await runMeasure("SubTabBar");

        expect([bar.x, bar.y, bar.width, bar.height]).toEqual(SUB_TAB_BAR_FRAME);
        // The regression this file exists for: both used to resolve to the tab button.
        expect(bar.nativeTag).not.toBe(header.nativeTag);
        expect(bar.height).not.toBe(header.height);
        expect(bar.nativeTag).not.toBe(720);
        expect(header.nativeTag).not.toBe(720);
    });

    it("still reports a nativeTag on the shadow-node path", async () => {
        installFakeRuntime(buildTree());
        const r = await runMeasure("SubTabBar");
        // The tag lives on canonical here, not on a public instance — dropping it would be
        // a silent loss of the one stable identifier the result carries.
        expect(r.nativeTag).toBe(734);
    });

    it("prefers a public instance when the fiber has one", async () => {
        installFakeRuntime(buildTree());
        const r = await runMeasure("Pressable");
        expect(r.outcome).toBe("measured");
        expect(r.nativeTag).toBe(720);
    });

    it("reports no_match for a component that is not mounted", async () => {
        installFakeRuntime(buildTree());
        const r = await runMeasure("NotThere");
        expect(r.outcome).toBe("no_match");
    });

    it("honours the index when a component is mounted more than once", async () => {
        const first = fabricHost(610, SHOP_HEADER_FRAME);
        const second = fabricHost(611, [0, 100, 921, 379]);
        const root = composite(
            "Root",
            composite("ShopHeader", composite("View", first), composite("ShopHeader", composite("View", second)))
        );
        installFakeRuntime(root);
        expect((await runMeasure("ShopHeader", 0)).nativeTag).toBe(610);
        expect((await runMeasure("ShopHeader", 1)).nativeTag).toBe(611);
    });

    it("falls back to a deep host only when nothing shallower is measurable", async () => {
        // No Fabric UIManager at all: the shadow-node branch cannot fire, so the button is
        // genuinely the only thing that can be measured.
        installFakeRuntime(buildTree());
        delete (globalThis as Record<string, unknown>).nativeFabricUIManager;
        const r = await runMeasure("ShopHeader");
        expect(r.outcome).toBe("measured");
        expect(r.nativeTag).toBe(720);
    });
});
