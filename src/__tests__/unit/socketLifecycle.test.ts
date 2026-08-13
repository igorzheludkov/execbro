import { describe, it, expect, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * Two ways a healthy CDP socket was being thrown away.
 *
 * 1. `handleClose` deleted `connectedApps[appKey]` without checking the stored
 *    socket was the one that closed. During a flap the replacement is already
 *    registered under the same key by the time the old socket's close event
 *    lands, so a dead socket evicted the live one — and the registry then
 *    reported no Metro while a working connection sat open.
 *
 * 2. The keepalive terminated on one missed pong with a 1s interval, so a
 *    freshly-established socket could be killed ~2s in, mid post-connect setup,
 *    while it was actively carrying CDP traffic. Observed twice in the dev log
 *    as "No pong … terminating connection" immediately after "Reconnected".
 */

const { connectedApps, isSupersededSocket } = await import("../../core/state.js");
const { shouldTerminateForMissedPong } = await import("../../core/connectionState.js");

function app(ws: unknown): ConnectedApp {
    return {
        ws: ws as WebSocket,
        deviceInfo: {
            id: "dev-1",
            title: "Hermes React Native",
            description: "",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: "ws://localhost:8081/x",
            deviceName: "iPhone Air"
        },
        port: 8081,
        platform: "ios"
    } as ConnectedApp;
}

describe("isSupersededSocket", () => {
    beforeEach(() => connectedApps.clear());

    it("says a socket still holding its entry is not superseded", () => {
        const live = { readyState: WebSocket.OPEN };
        connectedApps.set("k", app(live));

        expect(isSupersededSocket("k", live)).toBe(false);
    });

    it("says a replaced socket is superseded", () => {
        const old = { readyState: WebSocket.CLOSED };
        const live = { readyState: WebSocket.OPEN };
        connectedApps.set("k", app(old));
        connectedApps.set("k", app(live));

        // The eviction this guards: `old` closing must not remove `live`.
        expect(isSupersededSocket("k", old)).toBe(true);
        expect(isSupersededSocket("k", live)).toBe(false);
    });

    it("does not call an unregistered socket superseded", () => {
        // A socket that dies during setup was never registered. It must still run
        // its own teardown and schedule the reconnect — skipping that would trade
        // a flap for a connection that silently never comes back.
        expect(isSupersededSocket("k", { readyState: WebSocket.OPEN })).toBe(false);
    });
});

describe("shouldTerminateForMissedPong", () => {
    const now = 1_000_000;
    const quietWindowMs = 10_000;

    it("keeps a socket whose pong arrived", () => {
        expect(
            shouldTerminateForMissedPong({ pongReceived: true, lastCdpMessageAt: null, now, quietWindowMs })
        ).toBe(false);
    });

    it("keeps a socket that is still carrying CDP traffic", () => {
        // A socket delivering CDP messages is alive by definition; a late pong
        // says the process was busy, not that the connection died. This is the
        // case that was killing connections mid post-connect setup.
        expect(
            shouldTerminateForMissedPong({
                pongReceived: false,
                lastCdpMessageAt: new Date(now - 2_000),
                now,
                quietWindowMs
            })
        ).toBe(false);
    });

    it("terminates when the pong is missed and the socket has gone quiet", () => {
        expect(
            shouldTerminateForMissedPong({
                pongReceived: false,
                lastCdpMessageAt: new Date(now - 30_000),
                now,
                quietWindowMs
            })
        ).toBe(true);
    });

    it("terminates when there was never any traffic to vouch for it", () => {
        expect(
            shouldTerminateForMissedPong({ pongReceived: false, lastCdpMessageAt: null, now, quietWindowMs })
        ).toBe(true);
    });
});
