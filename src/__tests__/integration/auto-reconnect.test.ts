import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/jsExecute.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("auto-reconnect via CDP wrapper", () => {
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

    it("does NOT auto-retry on logical failure (ReferenceError)", async () => {
        server.respondWithError("ReferenceError", "__FOO__ is not defined");

        const result = await executeInApp("__FOO__", false, {
            maxRetries: 0,
            originatingToolName: "execute_in_app",
        });

        expect(result.success).toBe(false);
        // Logical CDP exception — outer wrapper must NOT mark _meta.reconnected.
        expect(result._meta?.reconnected).toBeFalsy();
        expect(result.error).not.toMatch(/^reconnect/);
        expect(result.error).toMatch(/ReferenceError/);
    });

    it("does NOT auto-retry on server-side timeoutMs (logical, not transport)", async () => {
        server.respondWithTimeout(); // never replies

        const result = await executeInApp("blockForever()", false, {
            maxRetries: 0,
            timeoutMs: 300,
            originatingToolName: "execute_in_app",
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Timeout: Expression took too long/);
        // Critical: a server-side timer hit is logical — no reconnect.
        expect(result._meta?.reconnected).toBeFalsy();
        expect(result.error).not.toMatch(/^reconnect/);
    });

    it("attempts reconnect on transport failure and surfaces _meta on the result", async () => {
        // Force a transport-classified failure by closing the WebSocket before the call.
        // executeInAppInner will return "WebSocket connection is not open." → classified as ws_closed.
        const app = [...connectedApps.values()][0]!;
        try { app.ws.close(); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 50));

        const result = await executeInApp("doSomething()", false, {
            maxRetries: 0,
            autoReconnect: false, // disable inner reconnect so outer wrapper's path is exercised
            originatingToolName: "execute_in_app",
        });

        expect(result.success).toBe(false);
        // The outer wrapper triggered reconnect path — Metro discovery from the test process
        // probes real ports (8081, 8082, 19000-19002). Either outcome is acceptable:
        //   - scan_failed → error starts "reconnect_attempted:"
        //   - retry_failed → error starts "reconnected_but_still_failed:"
        //   - success     → result.success === true, _meta.reconnected === true
        // What MUST hold: _meta exists and transportError captures the original message.
        if (result.success) {
            expect(result._meta?.reconnected).toBe(true);
        } else {
            expect(result.error).toMatch(/^(reconnect_attempted:|reconnected_but_still_failed:)/);
            expect(result._meta).toBeDefined();
            expect(result._meta?.transportError).toMatch(/WebSocket connection is not open|No apps connected/);
        }
    });
});
