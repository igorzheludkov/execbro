import { describe, it, expect, afterEach } from "@jest/globals";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { ensureConnection, expectLaunchedApp } from "../../core/connection.js";
import type { ConnectedApp } from "../../core/types.js";

afterEach(() => {
    connectedApps.clear();
});

// A runtime that attached a moment ago: the first probe goes unanswered, later ones succeed.
function freshlyAttachedPhone(): { app: ConnectedApp; probes: () => number } {
    let probes = 0;
    const ws = {
        readyState: 1,
        close() {},
        send(raw: string) {
            const { id } = JSON.parse(raw);
            probes++;
            if (probes === 1) return;
            setTimeout(() => pendingExecutions.get(id)?.resolve({ success: true, result: "2" }), 10);
        },
    };
    const app = {
        ws,
        port: 8081,
        platform: "ios",
        deviceInfo: { id: "phone-1", title: "RnDebuggerTestApp (iPhone)", deviceName: "iPhone", webSocketDebuggerUrl: "" },
    } as unknown as ConnectedApp;
    return { app, probes: () => probes };
}

describe("ensure_connection after a launch", () => {
    it("keeps probing a just-attached runtime within waitMs instead of failing on the first probe", async () => {
        const { app, probes } = freshlyAttachedPhone();
        connectedApps.set("8081-phone-1", app);
        expectLaunchedApp({ platform: "ios", phoneName: "iPhone", label: "iPhone" });

        const r = await ensureConnection({ port: 1, waitMs: 10000 });

        expect(r.healthCheckPassed).toBe(true);
        expect(probes()).toBeGreaterThanOrEqual(2);
    }, 20000);
});
