// Set test mode BEFORE importing src/index.ts so main() is skipped.
process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

const { connectedApps } = await import("../../core/state.js");
const { peekTargetPlatform, getFirstConnectedApp, chromiumAppFor } = await import("../../core/connection.js");
const { CHROMIUM_TOOLS, chromiumGate } = await import("../../core/chromiumCapabilities.js");
const { toolRegistry } = await import("../../index.js");

function makeApp(id: string, deviceName: string, platform: ConnectedApp["platform"]): ConnectedApp {
    return {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: { id, title: deviceName, description: "", appId: "", type: platform === "chromium" ? "page" : "node", webSocketDebuggerUrl: `ws://x/${id}`, deviceName },
        port: platform === "chromium" ? 9222 : 8081,
        platform,
    } as ConnectedApp;
}

describe("chromiumGate", () => {
    it("lets an allowlisted tool through on chromium", () => {
        expect(chromiumGate("get_logs", "chromium")).toBeNull();
    });

    it("rejects a non-allowlisted tool on chromium, naming the tool", () => {
        const r = chromiumGate("swipe", "chromium");
        expect(r?.isError).toBe(true);
        expect(r?.content[0].text).toContain("swipe");
        expect(r?._failureKind).toBe("platform_mismatch");
    });

    it("uses the override message where there is an obvious substitute", () => {
        expect(chromiumGate("navigate", "chromium")?.content[0].text).toContain("execute_in_app");
    });

    it("never touches mobile or unknown platforms", () => {
        expect(chromiumGate("swipe", "ios")).toBeNull();
        expect(chromiumGate("swipe", "android")).toBeNull();
        expect(chromiumGate("swipe", undefined)).toBeNull();
    });

    it("allowlists only tools that actually exist", () => {
        // reset_telemetry is registered only in dev mode, so the test registry lacks it.
        const devOnly = new Set(["reset_telemetry"]);
        for (const name of CHROMIUM_TOOLS) if (!devOnly.has(name)) expect(toolRegistry.has(name)).toBe(true);
    });
});

describe("peekTargetPlatform", () => {
    beforeEach(() => connectedApps.clear());
    afterEach(() => connectedApps.clear());

    it("reads the platform of the app the device argument names", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));
        connectedApps.set("b", makeApp("b", "FluentTalk", "chromium"));
        expect(peekTargetPlatform("get_screen_state", "FluentTalk")).toBe("chromium");
        expect(peekTargetPlatform("get_screen_state", "iPhone")).toBe("ios");
    });

    it("fails open when the device string is ambiguous or unknown", () => {
        connectedApps.set("a", makeApp("a", "FluentTalk", "chromium"));
        connectedApps.set("b", makeApp("b", "FluentTalk#2", "chromium"));
        // Two substring matches, no exact one: ambiguous. The gate must not reason
        // "both are chromium anyway", it fails open like every other uncertainty.
        expect(peekTargetPlatform("tap", "Fluent")).toBeUndefined();
        expect(peekTargetPlatform("tap", "nothing-like-this")).toBeUndefined();
    });

    it("with no device argument, answers for the app the handler will default to", () => {
        connectedApps.set("a", makeApp("a", "FluentTalk", "chromium"));
        expect(peekTargetPlatform("get_screen_state", undefined)).toBe("chromium");
        // Mixed session, chromium inserted FIRST: the bare call defaults to the RN app,
        // so the gate lets it through, and the handler must act on that same app.
        connectedApps.set("b", makeApp("b", "iPhone 17 Pro", "ios"));
        expect(peekTargetPlatform("get_screen_state", undefined)).toBe("ios");
        expect(getFirstConnectedApp()?.deviceInfo.deviceName).toBe("iPhone 17 Pro");
    });

    it("never infers a platform for a bare ios_/android_ tool call", () => {
        connectedApps.set("a", makeApp("a", "FluentTalk", "chromium"));
        expect(peekTargetPlatform("ios_screenshot", undefined)).toBeUndefined();
        expect(peekTargetPlatform("android_key_event", undefined)).toBeUndefined();
    });

    it("ignores apps whose socket is not open", () => {
        const closed = makeApp("a", "FluentTalk", "chromium");
        (closed.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
        connectedApps.set("a", closed);
        expect(peekTargetPlatform("get_screen_state", undefined)).toBeUndefined();
    });
});

describe("chromiumAppFor", () => {
    beforeEach(() => connectedApps.clear());
    afterEach(() => connectedApps.clear());

    it("returns the named chromium window, not the first one", () => {
        connectedApps.set("a", makeApp("a", "FluentTalk", "chromium"));
        connectedApps.set("b", makeApp("b", "FluentTalk#2", "chromium"));
        expect(chromiumAppFor("tap", "FluentTalk#2")?.deviceInfo.id).toBe("b");
        expect(chromiumAppFor("tap", "FluentTalk")?.deviceInfo.id).toBe("a");
    });

    it("returns null for a mobile target", () => {
        connectedApps.set("a", makeApp("a", "iPhone 17 Pro", "ios"));
        connectedApps.set("b", makeApp("b", "FluentTalk", "chromium"));
        expect(chromiumAppFor("tap", "iPhone")).toBeNull();
    });

    it("bare call: chromium only when chromium is the default target", () => {
        connectedApps.set("a", makeApp("a", "FluentTalk", "chromium"));
        expect(chromiumAppFor("screenshot", undefined)?.deviceInfo.id).toBe("a");
        // Mixed session: the RN app is the bare default, so the mobile path runs unchanged.
        connectedApps.set("b", makeApp("b", "iPhone 17 Pro", "ios"));
        expect(chromiumAppFor("screenshot", undefined)).toBeNull();
    });

    it("returns null (fails open) for an ambiguous or unknown device string", () => {
        connectedApps.set("a", makeApp("a", "FluentTalk", "chromium"));
        connectedApps.set("b", makeApp("b", "FluentTalk#2", "chromium"));
        expect(chromiumAppFor("tap", "Fluent")).toBeNull();
        expect(chromiumAppFor("tap", "nothing-like-this")).toBeNull();
    });
});

describe("screenshot on chromium", () => {
    it("is allowlisted, and the mobile screenshot tools point at it", () => {
        expect(chromiumGate("screenshot", "chromium")).toBeNull();
        expect(chromiumGate("ios_screenshot", "chromium")?.content[0].text).toContain("screenshot({ device");
        expect(chromiumGate("android_screenshot", "chromium")?.content[0].text).toContain("screenshot({ device");
    });
});
