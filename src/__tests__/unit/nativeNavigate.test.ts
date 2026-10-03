import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import { connectedApps } from "../../core/state.js";
import { openNativeSocket } from "../../core/nativeConnection.js";
import { nativeNavigate } from "../../core/nativeApp.js";
import { startFakeSdk, rpcError, HELLO } from "../helpers/fakeNativeSdk.js";

const ROUTES = ["onboarding", "home", "settings", "apps"];
let fake: Awaited<ReturnType<typeof startFakeSdk>>;
let app: ConnectedApp;
let stack: string[];

const snapshot = () => ({ route: stack[stack.length - 1], arguments: {}, backStack: [...stack] });

beforeEach(async () => {
    stack = ["home"];
    fake = await startFakeSdk((method, params) => {
        switch (method) {
            case "execbro.hello": return HELLO;
            case "nav.routes": return { start: "home", destinations: ROUTES.map((route) => ({ route, arguments: [] })) };
            case "nav.current": return snapshot();
            case "nav.navigate": {
                const before = snapshot();
                const to = params.to as string | undefined;
                if (to && !ROUTES.includes(to)) throw rpcError("NOT_FOUND", `No route '${to}'. Routes: ${ROUTES.join(", ")}`);
                if (params.action === "back") stack.pop();
                else if (params.action === "push") stack.push(to!);
                else if (params.action === "navigate") {
                    const i = stack.indexOf(to!);
                    if (i >= 0) stack = stack.slice(0, i + 1); else stack.push(to!);
                }
                return { before, after: snapshot() };
            }
            default: throw rpcError("METHOD_NOT_FOUND", method);
        }
    });
    app = await openNativeSocket(fake.url, { serial: "emulator-5554", pkg: "com.example.app", port: fake.port });
});

afterEach(async () => {
    for (const a of connectedApps.values()) a.ws.terminate();
    connectedApps.clear();
    await fake.close();
});

describe("nativeNavigate", () => {
    it("moves and reports before, after, stack and changed", async () => {
        const r = await nativeNavigate(app, { action: "push", to: "settings" });
        expect(r).toMatchObject({
            success: true, kind: "jetpack-navigation", action: "push", to: "settings",
            route: { before: "home", after: "settings" }, changed: true, indeterminate: false,
            stack: ["home", "settings"]
        });
    });

    it("walks home -> settings -> apps -> back and lands on settings", async () => {
        await nativeNavigate(app, { action: "push", to: "settings" });
        await nativeNavigate(app, { action: "push", to: "apps" });
        const r = await nativeNavigate(app, { action: "back" });
        expect(r.route.after).toBe("settings");
    });

    it("reports changed false when the destination is already current", async () => {
        const r = await nativeNavigate(app, { action: "navigate", to: "home" });
        expect(r.success).toBe(true);
        expect(r.changed).toBe(false);
    });

    it("lists the route table without moving", async () => {
        const r = await nativeNavigate(app, { action: "navigate", includeRouteTable: true });
        expect(r.routeTable).toEqual(ROUTES);
        expect(r.route).toEqual({ before: "home", after: "home" });
        expect(r.changed).toBe(false);
    });

    it("reports an unknown route with the SDK's list", async () => {
        const r = await nativeNavigate(app, { action: "push", to: "nope" });
        expect(r.success).toBe(false);
        expect(r.error).toContain("NOT_FOUND");
        expect(r.error).toContain("settings");
    });

    it("asks for a destination when none is given", async () => {
        const r = await nativeNavigate(app, { action: "push" });
        expect(r.success).toBe(false);
        expect(r.error).toContain("routeTable: true");
    });
});
