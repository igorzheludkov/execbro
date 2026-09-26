import { describe, it, expect } from "@jest/globals";
import { staleTargetMessage } from "../../core/connection.js";
import type { DeviceInfo } from "../../core/types.js";

const page = { id: "A", type: "page", title: "FluentTalk", description: "", url: "http://localhost:5173/", deviceName: "FluentTalk", webSocketDebuggerUrl: "ws://x" } as unknown as DeviceInfo;
const rn = { id: "B", type: "node", title: "Hermes React Native", description: "React Native Bridgeless", deviceName: "iPhone Air", webSocketDebuggerUrl: "ws://y" } as unknown as DeviceInfo;

describe("staleTargetMessage", () => {
    it("on a chromium window, points at a JavaScript dialog, not at Metro", () => {
        const m = staleTargetMessage(page);
        expect(m).toContain("stale CDP target");
        expect(m).toContain("JavaScript dialog");
        expect(m).toContain("window's own buttons");
        expect(m).not.toContain("Metro");
    });
    it("keeps the React Native wording", () => {
        expect(staleTargetMessage(rn)).toBe("Skipped iPhone Air (stale CDP target — no response from JS context)");
    });
});
