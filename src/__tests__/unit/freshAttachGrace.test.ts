import { describe, it, expect, afterEach } from "@jest/globals";
import http from "http";
import type { AddressInfo } from "net";
import { WebSocketServer } from "ws";
import { connectedApps } from "../../core/state.js";
import { ensureConnection, connectToDevice, suppressReconnection } from "../../core/connection.js";
import { cancelAllReconnectionTimers } from "../../core/connectionState.js";
import type { DeviceInfo } from "../../core/types.js";

/**
 * ensure_connection with the default waitMs: 0, right after a launch or reload. Telemetry (2026-11-04..18): 304 of 523 failures were a just-attached app that answered seconds later: a stale first probe (143), "Connection succeeded but app is not available" while another attempt held the device (118), or a failed first health check (43). Each cost the agent a turn to retry.
 */

// "1+1" is what both the liveness probe and the health check evaluate.
type Policy = (n: { socket: number; ping: number }) => { drop?: boolean; delayMs?: number };

async function fakeMetro(policy: Policy) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    let sockets = 0;
    let pings = 0;
    wss.on("connection", (ws) => {
        const socket = ++sockets;
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            let verdict: ReturnType<Policy> = {};
            if (msg.params?.expression === "1+1") verdict = policy({ socket, ping: ++pings });
            if (verdict.drop) return;
            const reply = () => ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "number", value: 2 } } }));
            if (verdict.delayMs) setTimeout(reply, verdict.delayMs);
            else reply();
        });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const device = {
        id: "d1",
        type: "node",
        title: "Hermes React Native",
        description: "React Native Bridgeless",
        deviceName: "Fake Phone",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=d1&page=1`,
    } as unknown as DeviceInfo;
    server.on("request", (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url?.startsWith("/json") ? [device] : {}));
    });
    const close = async () => {
        for (const c of wss.clients) c.terminate();
        await new Promise((r) => wss.close(r));
        await new Promise((r) => server.close(r));
    };
    return { port, device, close };
}

let metro: Awaited<ReturnType<typeof fakeMetro>> | null = null;

afterEach(async () => {
    suppressReconnection();
    for (const app of connectedApps.values()) app.ws.terminate();
    await metro?.close();
    metro = null;
    await new Promise((r) => setTimeout(r, 50));
    cancelAllReconnectionTimers();
    connectedApps.clear();
});

describe("ensure_connection on a just-attached app, default waitMs", () => {
    it("waits for an attach already in progress instead of reporting the app unavailable", async () => {
        // The probe answers after 1.2s, so the first attempt holds the device's lock that long.
        metro = await fakeMetro(({ ping }) => (ping === 1 ? { delayMs: 1200 } : {}));
        const inFlight = connectToDevice(metro.device, metro.port);

        const r = await ensureConnection({ port: metro.port, healthCheck: false });
        await inFlight;

        expect(r.error).toBeUndefined();
        expect(r.connected).toBe(true);
    }, 20000);

    it("keeps probing a target that reads stale on the first attach", async () => {
        metro = await fakeMetro(({ socket }) => (socket === 1 ? { drop: true } : {}));

        const r = await ensureConnection({ port: metro.port, healthCheck: false });

        expect(r.error).toBeUndefined();
        expect(r.connected).toBe(true);
    }, 20000);

    it("re-runs a health check the just-attached runtime missed", async () => {
        // ping 1 is the attach probe; ping 2 is the first health check.
        metro = await fakeMetro(({ ping }) => (ping === 2 ? { drop: true } : {}));

        const r = await ensureConnection({ port: metro.port });

        expect(r.connected).toBe(true);
        expect(r.healthCheckPassed).toBe(true);
    }, 20000);
});
