import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/jsExecute.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

// A socket that dies mid-call used to leave the request parked for the whole
// timeoutMs and then report "Timeout: Expression took too long", which the
// auto-reconnect wrapper classified as a logical timeout — so it never retried.
// Telemetry: 48 events/30d across 12 tools, durations sitting exactly on the
// timeout values (5001 / 10001 / 30007ms).
describe("socket close mid-flight", () => {
    let server: FakeCDPServer;
    let device: DeviceInfo;

    const MARKER = "__MIDFLIGHT_MARKER__";
    // Comfortably longer than the assertions below, so a pass cannot be the
    // timeout merely being short.
    const LONG_TIMEOUT_MS = 30_000;

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

    it("fails an in-flight call as a transport error instead of waiting out the timeout", async () => {
        // Never answer; drop the socket instead.
        server.onEvaluate((params) => {
            const expr = String((params as { expression?: string }).expression ?? "");
            if (expr.includes(MARKER)) {
                setImmediate(() => server.closeAllConnections());
            }
            return null;
        });

        const started = Date.now();
        const result = await executeInApp(`${MARKER}()`, false, {
            timeoutMs: LONG_TIMEOUT_MS,
            autoReconnect: false,
            originatingToolName: "execute_in_app",
        });
        const elapsed = Date.now() - started;

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/WebSocket connection is not open/i);
        expect(elapsed).toBeLessThan(5_000);
    });

    it("fails a poll issued after the socket died instead of waiting out the poll timeout", async () => {
        // First call returns the manual-await sentinel so we enter the poll
        // loop, then the socket dies while the loop is sleeping between polls.
        let answeredFirst = false;
        server.onEvaluate((params) => {
            const expr = String((params as { expression?: string }).expression ?? "");
            if (!expr.includes(MARKER)) return null;
            if (!answeredFirst) {
                answeredFirst = true;
                setImmediate(() => server.closeAllConnections());
                return { result: { result: { type: "string", value: "__awaiting__" } } };
            }
            return null;
        });

        const started = Date.now();
        const result = await executeInApp(`${MARKER}()`, true, {
            timeoutMs: LONG_TIMEOUT_MS,
            autoReconnect: false,
            originatingToolName: "execute_in_app",
        });
        const elapsed = Date.now() - started;

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/WebSocket connection is not open/i);
        expect(elapsed).toBeLessThan(5_000);
    });
});
