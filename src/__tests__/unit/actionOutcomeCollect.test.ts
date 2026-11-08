import { describe, it, expect } from "@jest/globals";
import { beginActionOutcome, finishActionOutcome, type OutcomeDeps } from "../../core/actionOutcomeCollect.js";
import type { OutcomeSnapshot } from "../../core/actionOutcome.js";
import { requestEvent } from "../../core/timeline.js";
import type { CollectResult } from "../../core/timelineSources.js";
import type { NetworkRequest } from "../../core/types.js";

const REQ = { requestId: "sdk-1", timestamp: new Date(1000), method: "POST", url: "http://localhost:8092/auth/login", headers: {}, status: 200, completed: true, epoch: 1 } as NetworkRequest;

function deps(over: Partial<OutcomeDeps> = {}) {
    let now = 1000;
    const calls = { resolveApp: [] as Array<string | undefined>, collect: [] as Array<string | undefined>, sleeps: [] as number[] };
    const snaps: OutcomeSnapshot[] = [
        { route: "Login", items: [{ text: "Sign in", x: 1, y: 800 }] },
        { route: "Login", items: [{ text: "Bad password", x: 1, y: 680 }, { text: "Sign in", x: 1, y: 800 }] },
    ];
    const d: OutcomeDeps = {
        resolveApp: async (device) => {
            calls.resolveApp.push(device);
            return { deviceName: "sdk_gphone16k_arm64 - 16 - API 36", chromium: false };
        },
        readSnapshot: async () => snaps.shift() ?? null,
        collect: async (deviceName): Promise<CollectResult> => {
            calls.collect.push(deviceName);
            return { events: [requestEvent(REQ, "d", false)], devices: ["d"], notes: [], unavailable: [] };
        },
        idleFor: () => ({
            now: () => now,
            sleep: async (ms) => {
                calls.sleeps.push(ms);
                now += ms;
            },
            refresh: async () => {},
            requests: () => [],
        }),
        now: () => now,
        ...over,
    };
    return { d, calls };
}

describe("action outcome collection", () => {
    it("resolves the app from the tap's own target", async () => {
        const { d, calls } = deps();
        const h = await beginActionOutcome("emulator-5554", d);
        const o = await finishActionOutcome(h, { visualSettleRan: true }, d);
        expect(calls.resolveApp).toEqual(["emulator-5554"]);
        expect(calls.collect).toEqual(["sdk_gphone16k_arm64 - 16 - API 36"]);
        expect(o).toEqual({
            route: "unchanged (Login)",
            text: ['+ "Bad password"'],
            network: [requestEvent(REQ, "d", false).text],
        });
    });

    it("a throwing snapshot read degrades to unavailable", async () => {
        const { d } = deps({ readSnapshot: async () => { throw new Error("timeout"); } });
        const h = await beginActionOutcome(undefined, d);
        const o = await finishActionOutcome(h, { visualSettleRan: true }, d);
        expect(o.unavailable).toContain("text: snapshot read failed");
        expect(o.network).toHaveLength(1);
        expect(o.route).toBeUndefined();
    });

    it("does not read the after-snapshot when the before-snapshot already failed", async () => {
        // A wedged JS thread costs one 3s timeout, not two.
        let reads = 0;
        const { d } = deps({ readSnapshot: async () => { reads++; throw new Error("timeout"); } });
        await finishActionOutcome(await beginActionOutcome(undefined, d), { visualSettleRan: true }, d);
        expect(reads).toBe(1);
    });

    it("no app: route and text unavailable, buffers still read", async () => {
        const { d, calls } = deps({ resolveApp: async () => null });
        const h = await beginActionOutcome("emulator-5554", d);
        const o = await finishActionOutcome(h, { visualSettleRan: true }, d);
        expect(o.unavailable).toEqual(["route", "text: no React Native connection"]);
        expect(o.network).toHaveLength(1);
        expect(calls.collect).toEqual(["emulator-5554"]);
    });

    it("a failing buffer read degrades to unavailable", async () => {
        const { d } = deps({ collect: async () => { throw new Error('No device matches "x"'); } });
        const h = await beginActionOutcome("x", d);
        const o = await finishActionOutcome(h, { visualSettleRan: true }, d);
        expect(o.unavailable).toContain("network and logs: read failed");
        expect(o.text).toEqual(['+ "Bad password"']);
    });

    it("no app and no buffer for the device: says nothing was captured, not that a read failed", async () => {
        // After a server restart with the app disconnected there is no buffer to read.
        const { d } = deps({ resolveApp: async () => null, collect: async () => { throw new Error('No device matches "emulator-5554"'); } });
        const o = await finishActionOutcome(await beginActionOutcome("emulator-5554", d), { visualSettleRan: true }, d);
        expect(o.unavailable).toEqual(["route", "text: no React Native connection", "network and logs: nothing captured for this device"]);
    });

    it("the 3s cap counts from the end of the gesture, not from before the tap began", async () => {
        // A real tap spends ~4s resolving, gesturing and settling before finish runs. A
        // request it started that answers 500ms later must still be waited for.
        let now = 1000;
        const inflight = { requestId: "r", timestamp: new Date(1500), method: "POST", url: "http://x/auth", headers: {}, epoch: 1, completed: false } as NetworkRequest;
        const { d } = deps({
            now: () => now,
            idleFor: () => ({
                now: () => now,
                sleep: async (ms) => { now += ms; },
                refresh: async () => {},
                requests: () => [{ ...inflight, completed: now >= 5500 }],
            }),
        });
        const h = await beginActionOutcome(undefined, d);
        now = 5000; // the tap's own work
        const o = await finishActionOutcome(h, { visualSettleRan: true }, d);
        expect(o.pending).toBeUndefined();
        expect(now).toBeGreaterThanOrEqual(5500);
    });

    it("grace applies only without a visual settle", async () => {
        const a = deps();
        await finishActionOutcome(await beginActionOutcome(undefined, a.d), { visualSettleRan: false }, a.d);
        expect(a.calls.sleeps[0]).toBe(300);
        const b = deps();
        await finishActionOutcome(await beginActionOutcome(undefined, b.d), { visualSettleRan: true }, b.d);
        expect(b.calls.sleeps).toEqual([]);
    });
});
