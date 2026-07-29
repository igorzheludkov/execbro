import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/jsExecute.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

// A timeout while the socket is still OPEN is ambiguous. The 1s ping/pong
// keepalive terminates genuinely dead sockets within ~2s, so an OPEN socket
// means the transport was alive the whole time — but the CDP *target* can still
// be stale (app reloaded via shake / Metro 'r'), silently swallowing evaluates.
// Telemetry showed trivial expressions (`1+1`, `globalThis.__DEV__`) timing out
// this way, which no amount of "the expression was slow" explains.
//
// A single cheap probe separates the two cases.
describe("stale-target probe on ws=OPEN timeout", () => {
    let server: FakeCDPServer;
    let device: DeviceInfo;

    const MARKER = "__STALE_PROBE_MARKER__";
    const EXPR_TIMEOUT_MS = 1_500;

    beforeAll(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        for (const [key, app] of connectedApps.entries()) {
            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(key);
        }
        pendingExecutions.clear();

        server = new FakeCDPServer();
        const port = await server.start();

        device = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test Device",
            appId: "com.test.app",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        await connectToDevice(device, port, {
            reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
        });
    });

    afterEach(async () => {
        for (const [key, app] of connectedApps.entries()) {
            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(key);
        }
        pendingExecutions.clear();
        await server.stop();
    });

    const isProbe = (expr: string) => expr.trim() === "1+1";
    const probeOk = { result: { result: { type: "number", value: 2 } } };

    it("leaves a genuinely slow expression alone when the probe still answers", async () => {
        // Target is healthy: probes answer. The marker expression just never
        // finishes — a real slow call, which must NOT trigger a reconnect.
        server.onEvaluate((params) => {
            const expr = String((params as { expression?: string }).expression ?? "");
            if (isProbe(expr)) return probeOk;
            return null;
        });

        const result = await executeInApp(`${MARKER}()`, false, {
            timeoutMs: EXPR_TIMEOUT_MS,
            originatingToolName: "execute_in_app",
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/took too long/i);
        expect(result.error).not.toMatch(/reconnect_attempted|reconnected_but_still_failed/);
    });

    // The silent-probe case is NOT tested here on purpose. Driving it through
    // executeInApp reaches attemptQuickReconnect -> scanMetroPorts(), which
    // scans real localhost ports and latches onto whatever Metro the developer
    // happens to be running — it hung against a live dev server. That decision
    // is covered without a socket by the classifyWithLivenessProbe unit tests.
});
