import { describe, it, expect, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * `get_screen_state`, `get_screen_layout` and `measure` gate on
 * `connectedApps.size > 0` and give up immediately. A CDP socket that drops and
 * reconnects — the log shows attempts at 500ms, 1s, 2s, 4s — empties that map
 * for the length of the gap, so a call landing inside one is told there is no
 * Metro at all. Meanwhile `tap` auto-connects and answers normally, so the same
 * app is simultaneously "not connected" and fully inspectable.
 *
 * Waiting is only correct while a reconnection is actually in flight. With
 * nothing pending, the app genuinely is not running, and every one of those
 * calls must stay fast — a blanket sleep would tax the common case to rescue
 * the rare one.
 */

const { connectedApps } = await import("../../core/state.js");
const { awaitMetro, buildMetroMissingHint, takeLastAutoConnect } = await import("../../core/nativeOnlyHints.js");
const { saveReconnectionTimer, cancelReconnectionTimer } = await import("../../core/connectionState.js");

function connectApp(key = "app-1"): void {
    connectedApps.set(key, {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: {
            id: key,
            title: "Hermes React Native",
            description: "",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: "ws://localhost:8081/x",
            deviceName: "iPhone Air"
        },
        port: 8081,
        platform: "ios"
    } as ConnectedApp);
}

/** A sleep that records what it was asked to wait, and never actually waits. */
function fakeSleep() {
    const waits: number[] = [];
    return {
        waits,
        sleep: async (ms: number) => {
            waits.push(ms);
        }
    };
}

describe("awaitMetro", () => {
    beforeEach(() => {
        connectedApps.clear();
        cancelReconnectionTimer("app-1");
        takeLastAutoConnect();
    });

    it("answers immediately when an app is connected", async () => {
        connectApp();
        const { waits, sleep } = fakeSleep();

        expect(await awaitMetro({ sleep })).toBe(true);
        expect(waits).toEqual([]);
    });

    it("does not wait when nothing is reconnecting", async () => {
        const { waits, sleep } = fakeSleep();

        // Nothing connected, nothing in flight: the app really is not running,
        // and this is the common case. It must not pay for the rare one.
        expect(await awaitMetro({ sleep, connect: async () => ({ ports: [], failures: [] }) })).toBe(false);
        expect(waits).toEqual([]);
    });

    it("auto-connects once when nothing is connected and nothing is reconnecting", async () => {
        const { waits, sleep } = fakeSleep();
        let calls = 0;
        const connect = async () => {
            calls++;
            connectApp();
            return { ports: [8090], failures: [] };
        };
        expect(await awaitMetro({ sleep, connect })).toBe(true);
        expect(calls).toBe(1);
        expect(waits).toEqual([]);
    });

    it("does not auto-connect while a reconnection is pending", async () => {
        const timer = setTimeout(() => {}, 10_000);
        saveReconnectionTimer("app-1", timer);
        let calls = 0;
        const { sleep } = fakeSleep();
        await awaitMetro({
            timeoutMs: 200,
            sleep,
            connect: async () => {
                calls++;
                return { ports: [], failures: [] };
            }
        });
        expect(calls).toBe(0);
        clearTimeout(timer);
    });

    it("returns false fast when the scan finds nothing", async () => {
        const { waits, sleep } = fakeSleep();
        expect(await awaitMetro({ sleep, connect: async () => ({ ports: [], failures: [] }) })).toBe(false);
        expect(waits).toEqual([]);
    });

    it("hands the outcome to the next hint exactly once", async () => {
        await awaitMetro({ connect: async () => ({ ports: [], failures: [] }) });
        expect(takeLastAutoConnect()).toEqual({ ports: [], failures: [] });
        expect(takeLastAutoConnect()).toBeNull();
    });

    it("waits for an in-flight reconnection and reports the recovery", async () => {
        const timer = setTimeout(() => {}, 60_000);
        saveReconnectionTimer("app-1", timer);
        const { waits, sleep } = fakeSleep();

        // The socket comes back on the third poll, as a real reconnect would
        // land partway through the budget.
        let polls = 0;
        const countingSleep = async (ms: number) => {
            await sleep(ms);
            if (++polls === 3) connectApp();
        };

        expect(await awaitMetro({ sleep: countingSleep })).toBe(true);
        expect(waits.length).toBe(3);
        clearTimeout(timer);
    });

    it("gives up inside its budget when the reconnection never lands", async () => {
        const timer = setTimeout(() => {}, 60_000);
        saveReconnectionTimer("app-1", timer);
        const { waits, sleep } = fakeSleep();

        expect(await awaitMetro({ timeoutMs: 2000, sleep })).toBe(false);
        // Bounded: the sum of what it asked to wait never exceeds the budget.
        expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
        expect(waits.length).toBeGreaterThan(0);
        clearTimeout(timer);
    });
});

describe("the no-Metro hint", () => {
    it("names the reconnecting device instead of telling the user to scan again", () => {
        const hint = buildMetroMissingHint({
            toolName: "get_screen_state",
            devices: { ios: true, android: true, any: true },
            reconnecting: ["iPhone Air"]
        });

        expect(hint).toMatch(/iPhone Air/);
        expect(hint).toMatch(/reconnect/i);
        // "Run scan_metro" is wrong advice while a reconnection is already in
        // flight — the user just ran it, and it worked.
        expect(hint).not.toMatch(/run scan_metro/i);
    });

    it("does not present an attached device as if it were the connection", () => {
        const hint = buildMetroMissingHint({
            toolName: "get_screen_state",
            devices: { ios: true, android: true, any: true }
        });

        // The old text read "Detected iOS simulator + Android device but no
        // Metro connection", which drags an unrelated Android device into a
        // report about the iOS app. Attached is not connected; say so.
        expect(hint).toMatch(/attached/i);
        expect(hint).toMatch(/scan_metro/);
    });

    it("still guides the user when nothing is running at all", () => {
        const hint = buildMetroMissingHint({
            toolName: "get_screen_state",
            devices: { ios: false, android: false, any: false }
        });

        expect(hint).toMatch(/No running simulators or devices/i);
    });

    it("hint after a scan that found no Metro names connect_metro", () => {
        const hint = buildMetroMissingHint({
            toolName: "get_screen_state",
            devices: { ios: true, android: false, any: true },
            autoConnect: { ports: [], failures: [] }
        });
        expect(hint).toContain("Scanned Metro ports 8081 to 8090: nothing is listening.");
        expect(hint).toContain("connect_metro({ port })");
        expect(hint).not.toContain("Start your React Native app");
    });

    it("hint after Metro was found but no app attached names ensure_connection", () => {
        const hint = buildMetroMissingHint({
            toolName: "get_screen_state",
            autoConnect: {
                ports: [8090],
                failures: ["Metro is running on port(s) 8090 but reports no debuggable targets"]
            }
        });
        expect(hint).toContain("Found Metro on port 8090, but no app attached:");
        expect(hint).toContain("ensure_connection({ waitMs: 60000 })");
    });
});
