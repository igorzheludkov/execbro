import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { connectedApps, clearAllCDPMessageTimes, updateLastCDPMessageTime } from "../../core/state.js";
import { markContextStale, initContextHealth, clearContextHealth } from "../../core/connectionState.js";
import { passiveConnectionBanner } from "../../core/connection.js";
import type { ConnectedApp } from "../../core/types.js";

/**
 * "Disconnected. Showing cached data." is a strong instruction to re-run
 * scan_metro, which throws away the navigation stack, auth and in-memory caches
 * of the app under test. Only a missing socket is measured evidence for it; a
 * stale execution context or a gap in recorded CDP traffic are inferences that
 * survive a perfectly healthy app, and the banner must say so.
 */

const APP_KEY = "8081-device1";

function connect(): void {
    connectedApps.set(APP_KEY, {
        ws: { readyState: 1 },
        port: 8081,
        platform: "ios",
        deviceInfo: { id: "device1", title: "iPhone", deviceName: "iPhone" }
    } as unknown as ConnectedApp);
    initContextHealth(APP_KEY);
}

describe("passiveConnectionBanner", () => {
    beforeEach(() => {
        connectedApps.clear();
        clearAllCDPMessageTimes();
        clearContextHealth(APP_KEY);
    });
    afterEach(() => {
        connectedApps.clear();
        clearAllCDPMessageTimes();
    });

    it("says nothing while the connection is healthy", () => {
        connect();
        updateLastCDPMessageTime(APP_KEY, new Date());
        expect(passiveConnectionBanner()).toBe("");
    });

    it("reports a genuinely absent socket as disconnected", () => {
        expect(passiveConnectionBanner()).toContain("Disconnected");
    });

    it("does not claim disconnection from an inferred stale context", () => {
        connect();
        updateLastCDPMessageTime(APP_KEY, new Date());
        markContextStale(APP_KEY);

        const banner = passiveConnectionBanner();
        expect(banner).not.toContain("Disconnected");
        expect(banner).toContain("Status unknown");
        expect(banner).toContain("ensure_connection");
    });

    it("does not claim disconnection merely because no CDP traffic was recorded", () => {
        connect();

        const banner = passiveConnectionBanner();
        expect(banner).not.toContain("Disconnected");
        expect(banner).toContain("no_activity");
    });
});
