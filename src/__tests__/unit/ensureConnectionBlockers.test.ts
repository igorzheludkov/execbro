import { describe, it, expect, jest, afterEach } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import type { LaunchProbe } from "../../core/launchBlockers.js";

// The device reads are launchBlockers' own tests; here the question is only
// whether ensure_connection stops waiting when one names a cause.
const probes: LaunchProbe[] = [];
let blocker: string | null = null;
jest.unstable_mockModule("../../core/launchBlockers.js", () => ({
    blockerWatch: (p: LaunchProbe) => {
        probes.push(p);
        return async () => blocker;
    },
}));

const { connectedApps } = await import("../../core/state.js");
const { ensureConnection, expectLaunchedApp } = await import("../../core/connection.js");

const LAUNCH = { platform: "android" as const, id: "emulator-5554", appId: "com.rndebuggertestapp", label: "emulator-5554" };
const SCREEN_OFF = "The screen of emulator-5554 is off, so the app cannot come to the foreground and load its bundle.";

afterEach(() => {
    connectedApps.clear();
    probes.length = 0;
    blocker = null;
});

describe("ensure_connection stops waiting when the launched device says why", () => {
    it("with nothing connected", async () => {
        blocker = SCREEN_OFF;
        expectLaunchedApp(LAUNCH);
        const started = Date.now();
        // Port 1: nothing answers there, so without the blocker this waits the full 30 s.
        const r = await ensureConnection({ port: 1, waitMs: 30_000 });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(r.connected).toBe(false);
        expect(r.error).toContain(SCREEN_OFF);
        // Where Metro really is: next to where the app looked, a port mismatch reads at once.
        expect(r.error).toContain("Metro here is on port 1.");
        expect(probes[0]).toMatchObject({ platform: "android", id: "emulator-5554", appId: "com.rndebuggertestapp" });
        expect(typeof probes[0].launchedAt).toBe("number");
    }, 15_000);

    it("while another app is connected", async () => {
        blocker = SCREEN_OFF;
        connectedApps.set("1-sim", {
            ws: { readyState: 1, close() {}, send() {} },
            port: 1,
            platform: "ios",
            simulatorUdid: "SIM-1",
            deviceInfo: { id: "sim", title: "App (iPhone Air)", deviceName: "iPhone Air", webSocketDebuggerUrl: "" },
        } as unknown as ConnectedApp);
        expectLaunchedApp(LAUNCH);
        const started = Date.now();
        const r = await ensureConnection({ port: 1, waitMs: 30_000, healthCheck: false });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(r.error).toContain(SCREEN_OFF);
        expect(r.error).toContain("Metro here is on port 1.");
    }, 15_000);

    it("keeps waiting when the device names nothing", async () => {
        expectLaunchedApp(LAUNCH);
        const started = Date.now();
        const r = await ensureConnection({ port: 1, waitMs: 2500 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(2400);
        expect(r.connected).toBe(false);
    }, 15_000);
});

// Source contract: the launch tools must hand over the app id, or the device
// check has no app to look for and the wait is blind again.
describe("launch tools", () => {
    it("pass the app id to expectLaunchedApp on simulators and emulators", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync("src/tools/deviceTools.ts", "utf8");
        expect(src).toMatch(/expectLaunchedApp\(\{ platform: "android", id: serial, appId: packageName,/);
        expect(src).toMatch(/expectLaunchedApp\(\{ platform: "ios", id: launchUdid, appId: bundleId,/);
    });

    it("no hint suggests a 60 s wait any more", async () => {
        const { spawnSync } = await import("node:child_process");
        const hits = spawnSync("grep", ["-rln", "waitMs: 60000\\|waitMs=60000", "src", "--exclude-dir=__tests__"], { encoding: "utf8" }).stdout.trim();
        expect(hits).toBe("");
    });
});
