import { describe, it, expect } from "@jest/globals";
import {
    buildNavHandlesSource,
    buildRouteTableSource,
    buildNearestRoutesSource,
    buildNavigateSource
} from "../../core/navigation.js";

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

    it("falls back to a mounted screen's navigation object when no container ref exists", () => {
        // <NavigationContainer> with no ref prop puts nothing carrying
        // resetRoot in the tree, which is the default shape and which used to
        // answer "No router resolved" on a perfectly ordinary router.
        const root = { which: "root", navigate: () => undefined, dispatch: () => undefined, getParent: () => null };
        const screen = { which: "screen", navigate: () => undefined, dispatch: () => undefined, getParent: () => root };
        const out = resolveWith({ __EB_TEST_SCREEN_NAV__: screen });
        expect(out.kind).toBe("react-navigation");
        // The ROOT navigator, not the screen's own: navigate on a nested
        // navigator only reaches that navigator's own routes.
        expect((out.navigator as { which: string }).which).toBe("root");
        // No getRootState anywhere on it, so destination validation is skipped
        // rather than run against an empty table.
        expect(out.stateReader).toBeNull();
        expect(String(out.note)).toContain("NavigationContainer");
    });

    it("prefers a real container ref over a screen's navigation object", () => {
        const screen = { navigate: () => undefined, dispatch: () => undefined, getParent: () => null };
        const out = resolveWith({ __EB_TEST_FIBER_NAV__: rnRootRef, __EB_TEST_SCREEN_NAV__: screen });
        expect(out.navigator).toBe(rnRootRef);
    });

    it("prefers the library module over an app-exposed global wrapper", () => {
        // Boardwise's __EXPO_ROUTER__ is a hand-built wrapper carrying its own
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

    it("gives the same route name with new params a different identity", () => {
        const state = { routeNames: ["GALLERY"], index: 0, routes: [{ name: "GALLERY" }] };
        const a = tableWith(state, { key: "g-1", name: "GALLERY", params: { id: 1 } }) as unknown as { currentId: string };
        const b = tableWith(state, { key: "g-1", name: "GALLERY", params: { id: 2 } }) as unknown as { currentId: string };
        expect(a.currentId).not.toBe(b.currentId);
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

describe("buildNavigateSource", () => {
    function run(
        globalStub: Record<string, unknown>,
        action: string,
        to: string | null,
        params: Record<string, unknown> | null = null
    ) {
        // The preamble is statements; only the navigate call is an expression.
        const preamble =
            buildNavHandlesSource() + "\n" + buildRouteTableSource() + "\n" + buildNearestRoutesSource();
        const fn = new Function("globalThis", preamble + "\nreturn " + buildNavigateSource(action, to, params) + ";");
        return fn(globalStub) as {
            ok: boolean; badArgs?: boolean; kind: string | null; error?: string; before?: string | null; routes?: string[];
        };
    }

    it("hands back the registered routes when the destination is missing", () => {
        // The agent has no other way to learn the route names, so a bare
        // "destination is required" is a dead end.
        const r = run(rnStub([]), "navigate", null);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("destination is required");
        expect(r.routes).toEqual(["Home", "TarotNav"]);
        // Flagged at the refusal site so telemetry can list it as a bad
        // argument rather than as a navigate defect. Set here, not matched on
        // the message later: the wording is free to change, the class is not.
        expect((r as { badArgs?: boolean }).badArgs).toBe(true);
    });

    it("does not flag a real navigation failure as a bad argument", () => {
        const r = run(rnStub([]), "navigate", "NoSuchRoute");
        expect(r.ok).toBe(false);
        expect((r as { badArgs?: boolean }).badArgs).toBeUndefined();
    });

    function rnStub(calls: string[]) {
        return {
            __EB_TEST_FIBER_NAV__: {
                navigate: (name: string) => calls.push("navigate:" + name),
                goBack: () => calls.push("goBack"),
                reset: () => calls.push("reset"),
                resetRoot: () => calls.push("resetRoot"),
                getCurrentRoute: () => ({ name: "Home" }),
                getRootState: () => ({ routeNames: ["Home", "TarotNav"], index: 0, routes: [{ name: "Home" }] })
            }
        };
    }

    function expoStub(calls: string[]) {
        return {
            __EB_TEST_MODULE_ROUTER__: {
                navigate: (p: string) => calls.push("navigate:" + p),
                push: (p: string) => calls.push("push:" + p),
                replace: (p: string) => calls.push("replace:" + p),
                back: () => calls.push("back"),
                dismiss: () => calls.push("dismiss")
            }
        };
    }

    it("emits Hermes-compatible ES5 only", () => {
        expect(buildNavigateSource("navigate", "/x", null)).not.toMatch(/=>|\bconst\b|\blet\b/);
        expect(buildNearestRoutesSource()).not.toMatch(/=>|\bconst\b|\blet\b/);
    });

    it("navigates by route name on React Navigation", () => {
        const calls: string[] = [];
        const out = run(rnStub(calls), "navigate", "TarotNav");
        expect(out.ok).toBe(true);
        expect(calls).toContain("navigate:TarotNav");
        expect(out.before).toBe("Home");
    });

    it("addresses a screen in an unfocused nested navigator from the root", () => {
        const calls: unknown[] = [];
        const stub = {
            __EB_TEST_FIBER_NAV__: {
                navigate: (name: string, p?: unknown) => calls.push([name, p]),
                resetRoot: () => undefined,
                getCurrentRoute: () => ({ name: "Tanstack" }),
                getRootState: () => ({
                    routeNames: ["Tabs"], index: 0,
                    routes: [{ name: "Tabs", state: {
                        routeNames: ["UiTab", "NetworkTab"], index: 1,
                        routes: [
                            { name: "UiTab", state: { routeNames: ["TapTargets", "Gallery"], index: 0, routes: [{ name: "TapTargets" }] } },
                            { name: "NetworkTab", state: { routeNames: ["Tanstack"], index: 0, routes: [{ name: "Tanstack" }] } }
                        ]
                    } }]
                })
            }
        };
        const out = run(stub, "navigate", "Gallery", { id: 2 });
        expect(out.ok).toBe(true);
        expect(calls).toEqual([["Tabs", { screen: "UiTab", params: { screen: "Gallery", params: { id: 2 } } }]]);
    });

    it("rejects an unknown route name before dispatching", () => {
        const calls: string[] = [];
        const out = run(rnStub(calls), "navigate", "NoSuchScreen");
        expect(out.ok).toBe(false);
        expect(String(out.error)).toContain("NoSuchScreen");
        expect(calls).toHaveLength(0);
    });

    it("suggests the nearest route names instead of listing all of them", () => {
        const calls: string[] = [];
        const many = {
            __EB_TEST_FIBER_NAV__: {
                navigate: (name: string) => calls.push("navigate:" + name),
                resetRoot: () => undefined,
                getCurrentRoute: () => ({ name: "Home" }),
                getRootState: () => ({
                    index: 0,
                    routeNames: [
                        "CheckoutVerification", "CheckoutProcessing", "AssociatedAccountVerification",
                        "VoucherVerification", "OtpVerification", "NeedHelp", "ThanksScreen",
                        "Home", "Cart", "GiftDetails", "SelectCountry", "ShippingAddresses"
                    ],
                    routes: [{ name: "Home" }]
                })
            }
        };
        // A dropped letter — substring matching alone would miss this.
        const out = run(many, "navigate", "CheckoutVerfication");
        expect(out.ok).toBe(false);
        expect(String(out.error)).toContain("Did you mean");
        expect(String(out.error)).toContain("CheckoutVerification");
        expect(String(out.error)).toContain("other routes registered");
        expect(String(out.error)).not.toContain("ShippingAddresses");
        expect(calls).toHaveLength(0);
    });

    it("navigates by path on Expo Router without route-name validation", () => {
        const calls: string[] = [];
        const out = run(expoStub(calls), "navigate", "/event-details?id=1");
        expect(out.ok).toBe(true);
        expect(calls).toContain("navigate:/event-details?id=1");
    });

    it("maps back to goBack on React Navigation and back on Expo Router", () => {
        const rnCalls: string[] = [];
        expect(run(rnStub(rnCalls), "back", null).ok).toBe(true);
        expect(rnCalls).toContain("goBack");

        const expoCalls: string[] = [];
        expect(run(expoStub(expoCalls), "back", null).ok).toBe(true);
        expect(expoCalls).toContain("back");
    });

    it("reports that push is unavailable on a React Navigation root ref", () => {
        const calls: string[] = [];
        const out = run(rnStub(calls), "push", "TarotNav");
        expect(out.ok).toBe(false);
        expect(String(out.error)).toContain("push");
        expect(calls).toHaveLength(0);
    });

    it("fails clearly when no router resolved", () => {
        const out = run({}, "navigate", "Anywhere");
        expect(out.ok).toBe(false);
        expect(String(out.error)).toContain("No router");
    });

    it("passes params through as the second argument", () => {
        const received: unknown[] = [];
        const stub = {
            __EB_TEST_MODULE_ROUTER__: {
                navigate: (p: string, q: unknown) => received.push([p, q]),
                dismiss: () => undefined
            }
        };
        const out = run(stub, "navigate", "/event-details", { id: "abc" });
        expect(out.ok).toBe(true);
        expect(received[0]).toEqual(["/event-details", { id: "abc" }]);
    });
});
