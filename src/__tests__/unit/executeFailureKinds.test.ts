import { jest, describe, it, expect, beforeEach } from "@jest/globals";

/**
 * executeInApp failures that reached telemetry with no failureKind (2026-11-04..18): no app / closed socket (85 rows across execute_in_app, navigate, input_text), the caller's promise rejecting (67-95), and the Hermes "async functions unsupported" guidance (10). Each must carry its kind to the result.
 */

// No Metro, so the reconnect wrapper gives up at once without touching a socket.
jest.unstable_mockModule("../../core/metro.js", () => ({
    scanMetroPorts: jest.fn<any>(async () => []),
    fetchDevices: jest.fn<any>(async () => []),
    selectMainDevice: jest.fn<any>(() => null),
    filterDebuggableDevices: jest.fn<any>((d: any) => d),
    isChromiumTarget: () => false,
    pickReconnectTarget: jest.fn(),
    pinChromiumName: (d: any) => d.deviceName,
}));

const { executeInApp, markConnectionEstablished } = await import("../../core/jsExecute.js");
const { connectedApps, pendingExecutions } = await import("../../core/state.js");

// Answers each Runtime.evaluate with the next scripted result. A "close" reply drops the socket mid-call, the way connection.ts fails in-flight calls on close.
function fakeApp(replies: Array<Record<string, unknown> | "close"> = []) {
    const ws = {
        readyState: 1,
        close() {},
        send(raw: string) {
            const { id } = JSON.parse(raw);
            let reply = replies.shift();
            if (reply === "close") {
                ws.readyState = 3;
                reply = { success: false, error: "WebSocket connection is not open." };
            }
            if (reply) setTimeout(() => pendingExecutions.get(id)?.resolve(reply as any), 0);
        },
    };
    connectedApps.set("8081-d1", {
        ws,
        port: 8081,
        platform: "ios",
        deviceInfo: { id: "d1", title: "App (iPhone)", deviceName: "iPhone", webSocketDebuggerUrl: "" },
    } as any);
}

const once = { maxRetries: 0, autoReconnect: false, skipBootstrap: true };

describe("executeInApp failureKind", () => {
    beforeEach(() => {
        connectedApps.clear();
        markConnectionEstablished();
    });

    it("tags no connected app as no_apps_connected", async () => {
        const r = await executeInApp("1", false, once);
        expect(r.failureKind).toBe("no_apps_connected");
    });

    it("keeps the kind through the reconnect wrapper", async () => {
        const r = await executeInApp("1", false, { maxRetries: 0, skipBootstrap: true });
        expect(r.error).toMatch(/^reconnect_attempted: /);
        expect(r.failureKind).toBe("no_apps_connected");
    });

    it("tags a closed socket as ws_closed", async () => {
        fakeApp(["close"]);
        const r = await executeInApp("1", false, once);
        expect(r.error).toBe("WebSocket connection is not open.");
        expect(r.failureKind).toBe("ws_closed");
    });

    it("keeps ws_closed through the reconnect wrapper", async () => {
        fakeApp(["close"]);
        const r = await executeInApp("1", false, { maxRetries: 0, skipBootstrap: true });
        expect(r.error).toMatch(/^reconnect_attempted: /);
        expect(r.failureKind).toBe("ws_closed");
    });

    it("tags the caller's rejected promise as app_exception", async () => {
        fakeApp([
            { success: true, result: "__awaiting__" },
            { success: true, result: JSON.stringify({ status: "err", value: "Error: boom" }) },
        ]);
        const r = await executeInApp("Promise.reject(new Error('boom'))", true, once);
        expect(r.error).toBe("Error: boom");
        expect(r.failureKind).toBe("app_exception");
    });

    it("tags the Hermes async-unsupported guidance as app_exception, compiled or cached", async () => {
        fakeApp([{ success: false, error: "SyntaxError: async functions are unsupported" }]);
        const compiled = await executeInApp("(async () => 1)()", false, once);
        expect(compiled.error).toMatch(/not supported by this device's Hermes build/);
        expect(compiled.failureKind).toBe("app_exception");

        const cached = await executeInApp("(async () => 2)()", false, once);
        expect(cached.error).toMatch(/not supported by this device's Hermes build/);
        expect(cached.failureKind).toBe("app_exception");
    });
});
