import { describe, it, expect, jest } from "@jest/globals";

// Opus benchmark: about 18 navigate calls failed with `No route named "Checkout"`,
// because Checkout sits in the Shop stack, which had not mounted yet. The agent
// then retried by hand through the parent route. performNavigation now does it.

type Route = { name: string; state?: State };
type State = { routeNames: string[]; index: number; routes: Route[] };

/** A fake React Navigation root whose stacks mount on first visit. */
function fakeApp(rootNames: string[], stacks: Record<string, string[]>) {
    const calls: Array<[string, unknown]> = [];
    let current = "Home";
    const root: State = {
        routeNames: rootNames,
        index: 0,
        routes: [{ name: "Tabs", state: { routeNames: ["Home"], index: 0, routes: [{ name: "Home" }] } }]
    };
    const nav = {
        navigate: (name: string, p?: { screen?: string }) => {
            calls.push([name, p]);
            const screens = stacks[name];
            if (screens && p?.screen && screens.includes(p.screen)) {
                root.routes.push({ name, state: { routeNames: screens, index: 0, routes: [{ name: p.screen }] } });
                current = p.screen;
            } else if (name === "Tabs") {
                current = p?.screen ?? "Home";
            } else {
                current = name;
            }
        },
        resetRoot: () => undefined,
        getCurrentRoute: () => ({ name: current, key: current }),
        getRootState: () => root
    };
    const executeInApp = async (expression: string) => {
        const result = new Function("globalThis", "return " + expression)({ __EB_TEST_FIBER_NAV__: nav });
        return { success: true, result };
    };
    return { calls, executeInApp };
}

let app = fakeApp([], {});
jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    executeInApp: (expression: string) => app.executeInApp(expression)
}));

const { performNavigation } = await import("../../core/navigate.js");

describe("navigate to a screen of a navigator that has not mounted", () => {
    it("reaches a screen inside an unmounted stack through its parent route", async () => {
        app = fakeApp(["Tabs", "Shop", "Account"], { Shop: ["ProductList", "Checkout"] });

        const r = await performNavigation({ action: "navigate", to: "Checkout" });

        expect(r.success).toBe(true);
        expect(r.via).toBe("Shop");
        expect(r.route.after).toBe("Checkout");
    }, 20000);

    it("goes back to the starting route when no parent holds the screen", async () => {
        app = fakeApp(["Tabs", "Shop", "Account"], { Shop: ["ProductList", "Checkout"] });

        const r = await performNavigation({ action: "navigate", to: "Nope" });

        expect(r.success).toBe(false);
        expect(r.error).toContain("Tried: Shop, Account (navigated back to Home).");
        expect(app.calls[app.calls.length - 1]).toEqual(["Tabs", { screen: "Home" }]);
    }, 20000);

    it("stops after 8 candidates", async () => {
        const many = Array.from({ length: 12 }, (_, i) => `Stack${i}`);
        app = fakeApp(["Tabs", ...many], {});

        await performNavigation({ action: "navigate", to: "Nope" });

        const tries = app.calls.filter(([, p]) => (p as { screen?: string } | undefined)?.screen === "Nope");
        expect(tries.length).toBe(8);
    }, 30000);
});
