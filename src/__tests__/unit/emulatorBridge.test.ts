import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emulatorRunningDir, resolveEmulatorBridge } from "../../core/emulatorBridge.js";

// Mirrors a real pid_<pid>.ini written by emulator 37.1.11.
const INI = [
    "emulator.build=15917651",
    "avd.id=Pixel_9",
    "port.serial=5554",
    "port.adb=5555",
    "avd.name=Pixel 9",
    "emulator.version=37.1.11.0",
    "grpc.token=dG9rZW4rd2l0aC9iYXNlNjQ9",
    "grpc.port=8554",
].join("\n");

describe("emulatorRunningDir", () => {
    it("returns the macOS discovery directory", () => {
        expect(emulatorRunningDir("darwin", "/Users/x")).toBe(
            "/Users/x/Library/Caches/TemporaryItems/avd/running"
        );
    });

    it("returns null on hosts where the path is unverified", () => {
        expect(emulatorRunningDir("linux", "/home/x")).toBeNull();
        expect(emulatorRunningDir("win32", "C:\\Users\\x")).toBeNull();
    });
});

describe("resolveEmulatorBridge", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "execbro-avd-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("resolves port and token from the ini whose port.serial matches", async () => {
        await writeFile(join(dir, "pid_26727.ini"), INI);
        const res = await resolveEmulatorBridge("emulator-5554", dir);
        expect(res).toEqual({
            ok: true,
            bridge: { port: 8554, token: "dG9rZW4rd2l0aC9iYXNlNjQ9", avdName: "Pixel 9" },
        });
    });

    it("picks the right emulator when several are running", async () => {
        await writeFile(join(dir, "pid_1.ini"), INI);
        await writeFile(
            join(dir, "pid_2.ini"),
            INI.replace("port.serial=5554", "port.serial=5556").replace("grpc.port=8554", "grpc.port=8556")
        );
        const res = await resolveEmulatorBridge("emulator-5556", dir);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.bridge.port).toBe(8556);
    });

    it("rejects a physical device serial without touching the filesystem", async () => {
        const res = await resolveEmulatorBridge("R5CT30XXXXX", dir);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("not-emulator");
    });

    it("reports no-discovery-file when nothing matches the serial", async () => {
        await writeFile(join(dir, "pid_1.ini"), INI);
        const res = await resolveEmulatorBridge("emulator-5560", dir);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("no-discovery-file");
    });

    it("reports no-grpc-keys when the ini lacks the gRPC entries", async () => {
        await writeFile(
            join(dir, "pid_1.ini"),
            "port.serial=5554\navd.name=Old AVD\n"
        );
        const res = await resolveEmulatorBridge("emulator-5554", dir);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("no-grpc-keys");
    });

    it("keeps base64 tokens intact when they contain '='", async () => {
        await writeFile(join(dir, "pid_1.ini"), INI);
        const res = await resolveEmulatorBridge("emulator-5554", dir);
        if (res.ok) expect(res.bridge.token).toBe("dG9rZW4rd2l0aC9iYXNlNjQ9");
    });
});
