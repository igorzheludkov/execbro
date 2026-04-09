import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { connectToDevice } from "../../core/connection.js";
import { checkAndEnsureConnection, getPassiveConnectionStatus } from "../../core/connection.js";
import { connectedApps, pendingExecutions, updateLastCDPMessageTime, clearAllCDPMessageTimes } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("Connection health (integration)", () => {
    let server: FakeCDPServer;

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
        clearAllCDPMessageTimes();
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
        if (server) await server.stop();
    });

    describe("getPassiveConnectionStatus", () => {
        it("returns no_connection when disconnected", () => {
            const status = getPassiveConnectionStatus();
            expect(status.connected).toBe(false);
            expect(status.reason).toBe("no_connection");
        });

        it("returns ok when connected with recent activity", async () => {
            server = new FakeCDPServer();
            const port = await server.start();

            const device: DeviceInfo = {
                id: "test-device",
                title: "Hermes React Native",
                description: "Test",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
                deviceName: "Test",
            };

            await connectToDevice(device, port, {
                reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
            });

            // Simulate recent CDP activity
            updateLastCDPMessageTime(`${port}-test-device`, new Date());

            const status = getPassiveConnectionStatus();
            expect(status.connected).toBe(true);
            expect(status.reason).toBe("ok");
        });

        it("returns activity_stale when no recent messages", async () => {
            server = new FakeCDPServer();
            const port = await server.start();

            const device: DeviceInfo = {
                id: "test-device",
                title: "Hermes React Native",
                description: "Test",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
                deviceName: "Test",
            };

            await connectToDevice(device, port, {
                reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
            });

            // Set last activity to 60 seconds ago
            updateLastCDPMessageTime(`${port}-test-device`, new Date(Date.now() - 60_000));

            const status = getPassiveConnectionStatus();
            expect(status.connected).toBe(true);
            expect(status.needsPing).toBe(true);
            expect(status.reason).toBe("activity_stale");
        });

        it("returns no_activity when connected but no CDP messages ever received", async () => {
            server = new FakeCDPServer();
            const port = await server.start();

            const device: DeviceInfo = {
                id: "test-device",
                title: "Hermes React Native",
                description: "Test",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
                deviceName: "Test",
            };

            await connectToDevice(device, port, {
                reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
            });

            // Note: handleCDPMessage will fire for enable responses, which updates timestamp
            // Reset it to null to simulate the "never received" case
            clearAllCDPMessageTimes();

            const status = getPassiveConnectionStatus();
            expect(status.connected).toBe(false);
            expect(status.reason).toBe("no_activity");
        });
    });

    describe("checkAndEnsureConnection", () => {
        it("returns failure when no Metro server is available", async () => {
            const result = await checkAndEnsureConnection();
            expect(result.connected).toBe(false);
            expect(result.wasReconnected).toBe(false);
            expect(result.message).toContain("No active connection");
        });

        it("returns success with no message when connection is healthy", async () => {
            server = new FakeCDPServer();
            const port = await server.start();

            const device: DeviceInfo = {
                id: "test-device",
                title: "Hermes React Native",
                description: "Test",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
                deviceName: "Test",
            };

            await connectToDevice(device, port, {
                reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
            });

            updateLastCDPMessageTime(`${port}-test-device`, new Date());

            const result = await checkAndEnsureConnection();
            expect(result.connected).toBe(true);
            expect(result.wasReconnected).toBe(false);
            expect(result.message).toBeNull();
        });
    });
});
