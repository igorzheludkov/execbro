import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import WebSocket from "ws";
import { collectTimeline, timelineDevices, type SourceDeps } from "../../core/timelineSources.js";
import { recordAction, resetActionLog } from "../../core/actionLog.js";
import { logBuffers, networkBuffers, connectedApps, getLogBuffer, getNetworkBuffer, bumpEpoch, resetEpochs } from "../../core/state.js";
import { recordChromiumNavigation, resetChromiumNavigations } from "../../core/chromiumNavigation.js";
import type { ConnectedApp } from "../../core/types.js";

const NOW = Date.now();
const window = { start: NOW - 10_000, end: NOW + 1000, label: "-10s", fallback: false };
const ALL = ["actions", "routes", "network", "logs", "restarts", "refresh"] as const;

const noDeps: SourceDeps = {
    readRoutes: async () => { throw new Error("should not be called"); },
    readRefresh: async () => { throw new Error("should not be called"); },
    probeDeviceNow: async () => { throw new Error("should not be called"); },
};

function connect(deviceName: string, platform: ConnectedApp["platform"], extra: Partial<ConnectedApp> = {}): void {
    connectedApps.set(`8081-${deviceName}`, {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: { id: deviceName, title: deviceName, description: "", appId: "", type: "node", webSocketDebuggerUrl: "ws://x", deviceName },
        port: 8081, platform, ...extra,
    } as ConnectedApp);
}

beforeEach(() => {
    resetActionLog(); resetEpochs(); resetChromiumNavigations();
    logBuffers.clear(); networkBuffers.clear(); connectedApps.clear();
});
afterEach(() => connectedApps.clear());

describe("collectTimeline from buffers", () => {
    it("merges actions, logs, requests and restarts in the window, and never reads the app when disconnected", async () => {
        recordAction({ tool: "tap", args: { testID: "add" }, startedAt: NOW - 5000, endedAt: NOW - 4000, ok: true });
        recordAction({ tool: "tap", args: { testID: "old" }, startedAt: NOW - 60_000, endedAt: NOW - 59_000, ok: true });
        getLogBuffer("iPhone").add({ level: "error", message: "boom", timestamp: new Date(NOW - 3000) });
        getNetworkBuffer("iPhone").set("7", { requestId: "7", timestamp: new Date(NOW - 4500), method: "GET", url: "https://a.com/x", headers: {}, completed: true, status: 200, epoch: 1 });
        bumpEpoch("iPhone");

        const r = await collectTimeline({ sources: [...ALL], window }, noDeps);
        expect(r.devices).toEqual(["iPhone"]);
        expect(r.events.map((e) => e.kind).sort()).toEqual(["action", "log", "request", "restart"]);
        expect(r.events.find((e) => e.kind === "action")?.text).toContain("testID=add");
        expect(r.notes.join("\n")).toMatch(/routes.*not connected/);
    });

    it("treats the reserved perf source as quiet: no events, no note, not unavailable", async () => {
        getLogBuffer("iPhone");
        const r = await collectTimeline({ sources: ["perf"], window }, noDeps);
        expect(r.events).toEqual([]);
        expect(r.notes).toEqual([]);
        expect(r.unavailable).toEqual([]);
    });

    it("always includes restarts, even when only logs were asked for", async () => {
        getLogBuffer("iPhone").add({ level: "log", message: "x", timestamp: new Date(NOW - 1000) });
        bumpEpoch("iPhone");
        const r = await collectTimeline({ sources: ["logs"], window }, noDeps);
        expect(r.events.map((e) => e.kind).sort()).toEqual(["log", "restart"]);
    });

    it("tags an action with no device when several devices are merged", async () => {
        getLogBuffer("iPhone"); getLogBuffer("Pixel");
        recordAction({ tool: "tap", args: { testID: "a" }, startedAt: NOW - 1000, endedAt: NOW, ok: true });
        recordAction({ tool: "tap", args: { testID: "b", device: "pixel" }, startedAt: NOW - 900, endedAt: NOW, ok: true });
        const r = await collectTimeline({ sources: ["actions"], window }, noDeps);
        expect(r.events.map((e) => e.device)).toEqual(["default", "Pixel"]);
    });

    it("filters to one device by substring", async () => {
        getLogBuffer("iPhone 17 Pro").add({ level: "log", message: "ios", timestamp: new Date(NOW - 1000) });
        getLogBuffer("Pixel 9").add({ level: "log", message: "android", timestamp: new Date(NOW - 1000) });
        recordAction({ tool: "tap", args: { testID: "p", device: "pixel" }, startedAt: NOW - 1000, endedAt: NOW, ok: true });
        const r = await collectTimeline({ device: "iphone", sources: ["logs", "actions"], window }, noDeps);
        expect(r.devices).toEqual(["iPhone 17 Pro"]);
        expect(r.events.map((e) => e.text).join("\n")).toContain("ios");
        expect(r.events.map((e) => e.text).join("\n")).not.toContain("android");
        expect(r.events.some((e) => e.kind === "action")).toBe(false);
    });

    it("shows hosts only when the window holds more than one", async () => {
        const nb = getNetworkBuffer("iPhone");
        nb.set("1", { requestId: "1", timestamp: new Date(NOW - 2000), method: "GET", url: "https://a.com/x", headers: {}, completed: true, status: 200, epoch: 1 });
        nb.set("2", { requestId: "2", timestamp: new Date(NOW - 1000), method: "GET", url: "https://b.com/y", headers: {}, completed: true, status: 200, epoch: 1 });
        const r = await collectTimeline({ sources: ["network"], window }, noDeps);
        expect(r.events.map((e) => e.text).join("\n")).toContain("a.com/x");
    });
});

describe("collectTimeline in-app sources", () => {
    it("reads routes and refresh from a connected RN app, shifted by the clock offset", async () => {
        connect("Pixel 9", "android");
        getLogBuffer("Pixel 9");
        const deps: SourceDeps = {
            probeDeviceNow: async () => Date.now() + 2000,
            readRoutes: async () => [{ route: "Cart", from: "Home", enteredAt: NOW - 1000 + 2000 }],
            readRefresh: async () => [{ at: NOW - 500 + 2000, modulePath: "/src/Cart.tsx" }],
        };
        const r = await collectTimeline({ sources: ["routes", "refresh"], window }, deps);
        const route = r.events.find((e) => e.kind === "route")!;
        expect(Math.abs(route.at - (NOW - 1000))).toBeLessThan(200);
        expect(r.events.find((e) => e.kind === "refresh")?.text).toBe("↻ edit applied: Cart.tsx");
        expect(r.notes.join("\n")).toMatch(/clock/i);
    });

    it("skips the clock probe on the iOS simulator", async () => {
        connect("iPhone", "ios", { simulatorUdid: "ABC" });
        const deps: SourceDeps = { ...noDeps, readRoutes: async () => [], readRefresh: async () => [] };
        const r = await collectTimeline({ sources: ["routes", "refresh"], window }, deps);
        expect(r.unavailable).toEqual([]);
    });

    it("names a failed in-app source and keeps the rest", async () => {
        connect("iPhone", "ios", { simulatorUdid: "ABC" });
        getLogBuffer("iPhone").add({ level: "log", message: "kept", timestamp: new Date(NOW - 1000) });
        const deps: SourceDeps = { ...noDeps, readRoutes: async () => { throw new Error("eval timed out"); }, readRefresh: async () => [] };
        const r = await collectTimeline({ sources: ["routes", "logs", "refresh"], window }, deps);
        expect(r.unavailable).toEqual(["routes"]);
        expect(r.notes.join("\n")).toContain("routes: unavailable (eval timed out)");
        expect(r.events.some((e) => e.text.includes("kept"))).toBe(true);
    });

    it("reads chromium routes from the navigation trail without evaluating in the page", async () => {
        connect("FluentTalk", "chromium");
        recordChromiumNavigation("FluentTalk", "http://x/home", 1, NOW - 3000);
        recordChromiumNavigation("FluentTalk", "http://x/settings", 1, NOW - 2000);
        const r = await collectTimeline({ sources: ["routes", "refresh"], window }, noDeps);
        expect(r.events.map((e) => e.text)).toEqual(["➜ route /home", "➜ route /settings (from /home)"]);
    });
});

describe("timelineDevices", () => {
    it("lists buffered and connected devices, or the one matching", () => {
        getLogBuffer("iPhone"); connect("Pixel", "android");
        expect(timelineDevices().sort()).toEqual(["Pixel", "iPhone"]);
        expect(timelineDevices("pix")).toEqual(["Pixel"]);
        expect(timelineDevices("nothing")).toEqual(["nothing"]);
    });
});
