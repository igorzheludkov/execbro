import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/jsExecute.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("per-call timeoutMs", () => {
    let server: FakeCDPServer;
    let device: DeviceInfo;

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
        const closePromises: Promise<void>[] = [];
        for (const [key, app] of connectedApps.entries()) {
            closePromises.push(
                new Promise<void>((resolve) => {
                    if (app.ws.readyState === app.ws.CLOSED) {
                        resolve();
                    } else {
                        app.ws.on("close", () => resolve());
                        try { app.ws.close(); } catch { resolve(); }
                    }
                })
            );
            connectedApps.delete(key);
        }
        await Promise.all(closePromises);
        pendingExecutions.clear();
        await server.stop();
    });

    it("forwards timeoutMs to Runtime.evaluate as the 'timeout' field", async () => {
        server.respondWithValue(1, "number");
        await executeInApp("doSomething()", false, { timeoutMs: 7777, originatingToolName: "execute_in_app" });

        // Find the non-probe Runtime.evaluate call. The probe sends "1+1"; we sent "doSomething()" which
        // becomes wrapped with the GLOBAL_POLYFILL.
        const evalMsg = server.receivedMessages.find(
            (m) => m.method === "Runtime.evaluate" && typeof m.params.expression === "string"
                && (m.params.expression as string).includes("doSomething()"),
        );
        expect(evalMsg).toBeDefined();
        expect(evalMsg!.params.timeout).toBe(7777);
    });

    it("Promise.race fires the server-side timer at the configured timeout", async () => {
        server.respondWithTimeout();
        const start = Date.now();
        const result = await executeInApp("blockForever()", false, {
            maxRetries: 0,
            timeoutMs: 500,
            originatingToolName: "execute_in_app",
        });
        const elapsed = Date.now() - start;

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Timeout: Expression took too long/);
        expect(elapsed).toBeGreaterThanOrEqual(450);
        expect(elapsed).toBeLessThan(2500);
        // Critical: a timeoutMs hit is logical, NOT transport — no reconnect marker.
        expect(result._meta?.reconnected).toBeFalsy();
    });

    it("clamps timeoutMs > 120000 and reports the original in _meta", async () => {
        server.respondWithValue(42, "number");
        const result = await executeInApp("getAnswer()", false, {
            timeoutMs: 3_000_000,
            originatingToolName: "execute_in_app",
        });
        expect(result.success).toBe(true);
        expect(result._meta?.timeoutClampedFrom).toBe(3_000_000);

        // And the forwarded Hermes-side timeout must be the clamped value, not the raw input.
        const evalMsg = server.receivedMessages.find(
            (m) => m.method === "Runtime.evaluate" && typeof m.params.expression === "string"
                && (m.params.expression as string).includes("getAnswer()"),
        );
        expect(evalMsg).toBeDefined();
        expect(evalMsg!.params.timeout).toBe(120000);
    });
});
