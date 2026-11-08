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

    it("grace applies only without a visual settle", async () => {
        const a = deps();
        await finishActionOutcome(await beginActionOutcome(undefined, a.d), { visualSettleRan: false }, a.d);
        expect(a.calls.sleeps[0]).toBe(300);
        const b = deps();
        await finishActionOutcome(await beginActionOutcome(undefined, b.d), { visualSettleRan: true }, b.d);
        expect(b.calls.sleeps).toEqual([]);
    });
});
