import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/executor.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("executeInApp (integration)", () => {
    let server: FakeCDPServer;
    let device: DeviceInfo;

    beforeAll(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        // Clean up any existing state
        for (const [key, app] of connectedApps.entries()) {
            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(key);
        }
        pendingExecutions.clear();

        // Start fake CDP server
        server = new FakeCDPServer();
        const port = await server.start();

        // Create device info pointing to fake server
        device = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test Device",
            appId: "com.test.app",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        // Connect to the fake server with reconnection disabled
        // to avoid background reconnection attempts during cleanup
        await connectToDevice(device, port, {
            reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
        });
    });

    afterEach(async () => {
        // Close all connected WebSockets and wait for them to fully close
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

    it("returns value for simple expression", async () => {
        server.respondWithValue(42, "number");
        const result = await executeInApp("21 + 21", false, { timeoutMs: 5000 });
        expect(result.success).toBe(true);
        expect(result.result).toBe("42");
    });

    it("returns string value", async () => {
        server.respondWithValue("hello", "string");
        const result = await executeInApp("'hello'", false, { timeoutMs: 5000 });
        expect(result.success).toBe(true);
        expect(result.result).toBe("hello");
    });

    it("returns object value as JSON", async () => {
        server.respondWithValue({ key: "value" }, "object");
        const result = await executeInApp("({key: 'value'})", false, { timeoutMs: 5000 });
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.result!);
        expect(parsed.key).toBe("value");
    });

    it("returns error for JS exception", async () => {
        server.respondWithError("ReferenceError", "x is not defined");
        const result = await executeInApp("x", false, { timeoutMs: 5000 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("ReferenceError");
    });

    it("sends expression with global polyfill prepended", async () => {
        server.respondWithValue(true, "boolean");
        await executeInApp("__DEV__", false, { timeoutMs: 5000 });
        const evalMsg = server.receivedMessages.find((m) => m.method === "Runtime.evaluate");
        expect(evalMsg).toBeDefined();
        const expr = (evalMsg!.params as { expression: string }).expression;
        expect(expr).toContain("var global");
        expect(expr).toContain("__DEV__");
    });

    it("rejects emoji in expression", async () => {
        const result = await executeInApp("'\ud83d\ude00'", false, { timeoutMs: 5000 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("emoji");
    });

    it("handles timeout gracefully", async () => {
        // Don't respond — causes timeout
        server.respondWithTimeout();
        const result = await executeInApp("slow()", false, { timeoutMs: 500, maxRetries: 0 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Timeout");
    }, 10000);
});
