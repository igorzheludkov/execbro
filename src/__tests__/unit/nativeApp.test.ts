import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import { connectedApps } from "../../core/state.js";
import { openNativeSocket } from "../../core/nativeConnection.js";
import { nativeListDebugGlobals, nativeInspectGlobal, nativeRunCommand } from "../../core/nativeApp.js";
import { startFakeSdk, rpcError, HELLO } from "../helpers/fakeNativeSdk.js";

let fake: Awaited<ReturnType<typeof startFakeSdk>>;
let app: ConnectedApp;
let locked = false;

beforeEach(async () => {
    locked = false;
    fake = await startFakeSdk((method, params) => {
        switch (method) {
            case "execbro.hello": return HELLO;
            case "state.list": return [{ name: "lock" }, { name: "prefs" }];
            case "command.list": return [{ name: "lock", description: "Engage the touch lock" }, { name: "resetPrefs", description: "" }];
            case "state.get":
                if (params.name === "lock") return { value: locked };
                if (params.name === "prefs") return { value: { posX: 0, allowedPackages: ["com.google.android.youtube"] } };
                throw rpcError("NOT_FOUND", `No state named '${String(params.name)}'. Registered: lock, prefs`);
            case "command.run":
                if (params.name === "lock") { locked = true; return { result: "locked" }; }
                throw rpcError("THREW", "java.lang.IllegalStateException: Bubble service is not running");
            default: throw rpcError("METHOD_NOT_FOUND", method);
        }
    });
    app = await openNativeSocket(fake.url, { serial: "emulator-5554", pkg: "com.example.app", port: fake.port });
});

afterEach(async () => {
    for (const a of connectedApps.values()) a.ws.terminate();
    connectedApps.clear();
    await fake.close();
});

describe("nativeListDebugGlobals", () => {
    it("lists state and commands in two groups", async () => {
        const r = await nativeListDebugGlobals(app);
        expect(r.success).toBe(true);
        expect(r.result).toContain("State (read with inspect_global");
        expect(r.result).toContain("  - prefs");
        expect(r.result).toContain("Commands (run with run_app_command");
        expect(r.result).toContain("  - lock: Engage the touch lock");
        expect(r.result).toContain("  - resetPrefs");
    });
});

describe("nativeInspectGlobal", () => {
    it("returns the value as JSON", async () => {
        const r = await nativeInspectGlobal(app, "prefs");
        expect(JSON.parse(r.result!)).toEqual({ posX: 0, allowedPackages: ["com.google.android.youtube"] });
    });

    it("reports a missing name with the SDK's code and list", async () => {
        const r = await nativeInspectGlobal(app, "nope");
        expect(r.success).toBe(false);
        expect(r.error).toBe("NOT_FOUND: No state named 'nope'. Registered: lock, prefs");
    });
});

describe("nativeRunCommand", () => {
    it("lists commands when no name is given", async () => {
        const r = await nativeRunCommand(app);
        expect(r.result).toBe("- lock: Engage the touch lock\n- resetPrefs");
    });

    it("runs a command and the state reflects it", async () => {
        expect((await nativeRunCommand(app, "lock")).result).toBe('lock -> "locked"');
        expect((await nativeInspectGlobal(app, "lock")).result).toBe("true");
    });

    it("surfaces an app-side exception", async () => {
        const r = await nativeRunCommand(app, "unlock");
        expect(r.success).toBe(false);
        expect(r.error).toContain("THREW");
        expect(r.error).toContain("Bubble service is not running");
    });
});
