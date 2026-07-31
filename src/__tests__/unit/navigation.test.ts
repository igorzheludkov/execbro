import { describe, it, expect } from "@jest/globals";
import { buildNavHandlesSource, buildRouteTableSource } from "../../core/navigation.js";

describe("buildNavHandlesSource", () => {
    const source = buildNavHandlesSource();

    function resolveWith(globalStub: Record<string, unknown>) {
        const run = new Function("globalThis", source + "; return __eb_nav;");
        return run(globalStub) as { navigator: unknown; stateReader: unknown; kind: string | null; note: string | null };
    }

    const expoRouter = {
        navigate: () => undefined,
        push: () => undefined,
        replace: () => undefined,
        back: () => undefined,
        dismiss: () => undefined,
        dismissAll: () => undefined,
        canDismiss: () => true,
        prefetch: () => undefined,
        setParams: () => undefined
    };
    const rnRootRef = {
        navigate: () => undefined,
        goBack: () => undefined,
        reset: () => undefined,
        resetRoot: () => undefined,
        dispatch: () => undefined,
        getRootState: () => ({ routes: [], index: 0 }),
        getCurrentRoute: () => ({ name: "Home" }),
        getState: () => ({ routes: [], index: 0 })
    };

    it("emits Hermes-compatible ES5 only", () => {
        expect(source).not.toMatch(/\bconst\b|\blet\b/);
        expect(source).not.toMatch(/=>/);
        expect(source).not.toMatch(/\basync\b/);
        expect(source).not.toContain("`");
    });

    it("returns all-null when nothing resolves", () => {
        const out = resolveWith({});
        expect(out.navigator).toBeNull();
        expect(out.stateReader).toBeNull();
        expect(out.kind).toBeNull();
        expect(String(out.note)).toContain("No router");
    });

    it("classifies a React Navigation root ref by resetRoot", () => {
        const out = resolveWith({ __EB_TEST_FIBER_NAV__: rnRootRef });
        expect(out.kind).toBe("react-navigation");
        expect(out.navigator).toBe(rnRootRef);
        expect(out.stateReader).toBe(rnRootRef);
    });

    it("classifies Expo Router by dismiss and pairs it with a fiber state reader", () => {
        const out = resolveWith({
            __EB_TEST_MODULE_ROUTER__: expoRouter,
            __EB_TEST_FIBER_NAV__: rnRootRef
        });
        expect(out.kind).toBe("expo-router");
        expect(out.navigator).toBe(expoRouter);
        // Expo Router has no getRootState — state must come from the fiber ref.
        expect(out.stateReader).toBe(rnRootRef);
    });

    it("notes when Expo Router resolved without a state reader", () => {
        const out = resolveWith({ __EB_TEST_MODULE_ROUTER__: expoRouter });
        expect(out.kind).toBe("expo-router");
        expect(out.stateReader).toBeNull();
        expect(String(out.note)).toContain("route state");
    });

    it("prefers the library module over an app-exposed global wrapper", () => {
        // AppB's __EXPO_ROUTER__ is a hand-built wrapper carrying its own
        // {router, currentPath, segments, ...}, not the library's router.
        const wrapper = { router: expoRouter, navigate: () => undefined, currentPath: "/" };
        const out = resolveWith({ __EB_TEST_MODULE_ROUTER__: expoRouter, __EXPO_ROUTER__: wrapper });
        expect(out.navigator).toBe(expoRouter);
    });
});

describe("buildRouteTableSource", () => {
    const source = buildNavHandlesSource() + "\n" + buildRouteTableSource();

    function tableWith(rootState: unknown, currentRoute: unknown) {
        const stub = {
            __EB_TEST_FIBER_NAV__: {
                navigate: () => undefined,
                resetRoot: () => undefined,
                getRootState: () => rootState,
                getCurrentRoute: () => currentRoute
            }
        };
        const run = new Function("globalThis", source + "; return __eb_routeTable();");
        return run(stub) as { levels: Array<{ routeNames: string[] }>; all: string[]; current: string };
    }

    it("emits Hermes-compatible ES5 only", () => {
        expect(buildRouteTableSource()).not.toMatch(/=>|\bconst\b|\blet\b/);
    });

    it("collects routeNames from every navigator level", () => {
        const out = tableWith(
            {
                type: "stack",
                index: 0,
                routeNames: ["__root", "+not-found"],
                routes: [
                    {
                        name: "__root",
                        state: {
                            type: "tab",
                            index: 1,
                            routeNames: ["index", "explore", "calendar"],
                            routes: [{ name: "index" }, { name: "explore" }]
                        }
                    }
                ]
            },
            { name: "explore" }
        );
        expect(out.levels).toHaveLength(2);
        expect(out.all).toEqual(expect.arrayContaining(["__root", "+not-found", "index", "explore", "calendar"]));
        expect(out.current).toBe("explore");
    });

    it("dedupes names that appear at more than one level", () => {
        const out = tableWith(
            {
                routeNames: ["a", "b"],
                index: 0,
                routes: [{ name: "a", state: { routeNames: ["b", "c"], index: 0, routes: [{ name: "b" }] } }]
            },
            { name: "b" }
        );
        expect(out.all.filter((n) => n === "b")).toHaveLength(1);
    });

    it("returns an empty table rather than throwing when there is no state reader", () => {
        const run = new Function("globalThis", source + "; return __eb_routeTable();");
        const out = run({}) as { levels: unknown[]; all: string[] };
        expect(out.levels).toHaveLength(0);
        expect(out.all).toHaveLength(0);
    });

    it("survives a state reader whose getRootState throws", () => {
        const stub = {
            __EB_TEST_FIBER_NAV__: {
                navigate: () => undefined,
                resetRoot: () => undefined,
                getRootState: () => {
                    throw new Error("not ready");
                }
            }
        };
        const run = new Function("globalThis", source + "; return __eb_routeTable();");
        const out = run(stub) as { levels: unknown[]; all: string[] };
        expect(out.all).toHaveLength(0);
    });
});
