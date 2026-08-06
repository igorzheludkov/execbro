import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import WebSocket from "ws";
import { handleCDPMessage } from "../../core/connection.js";
import { connectedApps } from "../../core/state.js";
import type { ConnectedApp, DeviceInfo } from "../../core/types.js";

// __RN_NET_DISABLED__ lives on the app's globalThis, so a reload that keeps the
// CDP connection (DevSettings.reload(), ⌘R, Fast Refresh full reload) wipes it
// while sdkPresent stays true. Without a context-driven write the re-injected
// interceptor emits alongside the SDK for the rest of the session.

const device: DeviceInfo = {
    id: "device-1",
    title: "React Native Bridgeless [C++ connection]",
    description: "",
    webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=1",
    deviceName: "iPhone Air",
} as DeviceInfo;

function fakeApp(sdkPresent: boolean | undefined, sent: string[]): ConnectedApp {
    const ws = {
        readyState: WebSocket.OPEN,
        send: (payload: string) => sent.push(payload),
        once: () => {},
    } as unknown as WebSocket;
    return {
        ws,
        deviceInfo: device,
        port: 8081,
        platform: "ios",
        sdkPresent,
    } as ConnectedApp;
}

function flagWrites(sent: string[]): boolean[] {
    return sent
        .map((raw) => JSON.parse(raw) as { params?: { expression?: string } })
        .map((m) => m.params?.expression ?? "")
        // Only the bare assignment — the injected interceptor source also
        // mentions the flag, as the guard it reads.
        .filter((e) => /^globalThis\.__RN_NET_DISABLED__ = (?:true|false)$/.test(e.trim()))
        .map((e) => e.includes("true"));
}

describe("__RN_NET_DISABLED__ on context recreation", () => {
    let sent: string[];
    let errorSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        sent = [];
        connectedApps.clear();
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        connectedApps.clear();
        errorSpy.mockRestore();
    });

    it("re-asserts the suppression flag when the SDK is present", () => {
        connectedApps.set("iPhone Air:8081", fakeApp(true, sent));

        handleCDPMessage({ method: "Runtime.executionContextCreated", params: { context: { id: 8 } } }, device);

        expect(flagWrites(sent)).toContain(true);
    });

    it("clears the flag on a new context when the SDK is absent", () => {
        connectedApps.set("iPhone Air:8081", fakeApp(false, sent));

        handleCDPMessage({ method: "Runtime.executionContextCreated", params: { context: { id: 8 } } }, device);

        // The interceptor is the capture path without the SDK — it must emit.
        expect(flagWrites(sent)).toEqual([false]);
    });

    it("treats an undetected SDK as not suppressed", () => {
        connectedApps.set("iPhone Air:8081", fakeApp(undefined, sent));

        handleCDPMessage({ method: "Runtime.executionContextCreated", params: { context: { id: 8 } } }, device);

        expect(flagWrites(sent)).toEqual([false]);
    });
});
