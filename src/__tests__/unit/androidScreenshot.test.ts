import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

/**
 * androidScreenshot used to `screencap` to /sdcard and `adb pull` it back: two round trips, each with a 30s timeout, and 25 of 35 production failures in 2026-11 were 30s+ hangs with no output. It now streams the PNG over `adb exec-out`. No device contact: the exec layer is stubbed.
 */

type ExecFn = (file: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
const execMock = jest.fn<ExecFn>();
jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execMock,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T>(p: Promise<T>) => p,
}));

const { androidScreenshot, resetAdbAvailabilityCache } = await import("../../core/android.js");

const SERIAL = "emulator-5554";
let png: Buffer;

function execError(cmd: string, stderr: string, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { cmd, stderr, code: 1, killed: false, ...extra });
}

/** Default device behaviour; `exec-out` answers with `execOut`. */
function device(execOut: () => Promise<{ stdout: string; stderr: string }>) {
    execMock.mockImplementation(async (_file, args) => {
        if (args[0] === "version") return { stdout: "Android Debug Bridge version 1.0.41", stderr: "" };
        if (args[0] === "devices") return { stdout: `List of devices attached\n${SERIAL}\tdevice\n`, stderr: "" };
        if (args.includes("exec-out")) return execOut();
        return { stdout: "", stderr: "" };
    });
}

const calls = () => execMock.mock.calls.map(([, args]) => args.join(" "));

beforeEach(async () => {
    execMock.mockReset();
    resetAdbAvailabilityCache();
    png = await sharp({ create: { width: 20, height: 40, channels: 3, background: "#f00" } }).png().toBuffer();
});

describe("androidScreenshot capture", () => {
    it("streams the PNG over exec-out: no sdcard file, no pull", async () => {
        device(async () => ({ stdout: png.toString("latin1"), stderr: "" }));
        const out = path.join(mkdtempSync(path.join(os.tmpdir(), "shot-")), "a.png");

        const r = await androidScreenshot(out, SERIAL);

        expect(r.success).toBe(true);
        expect(r.originalWidth).toBe(20);
        expect(readFileSync(out).equals(png)).toBe(true);
        expect(calls().some((c) => c.includes("pull"))).toBe(false);
        expect(calls().some((c) => c.includes("/sdcard"))).toBe(false);
        const execOut = execMock.mock.calls.find(([, a]) => a.includes("exec-out"))!;
        expect(execOut[1]).toEqual(["-s", SERIAL, "exec-out", "screencap", "-p"]);
        expect(execOut[2]?.timeout as number).toBeLessThanOrEqual(15000);
    });

    it("creates a missing output folder", async () => {
        device(async () => ({ stdout: png.toString("latin1"), stderr: "" }));
        const out = path.join(mkdtempSync(path.join(os.tmpdir(), "shot-")), "nested", "deeper", "a.png");

        const r = await androidScreenshot(out, SERIAL);

        expect(r.success).toBe(true);
        expect(existsSync(out)).toBe(true);
    });

    it("falls back to screencap + pull when exec-out fails fast", async () => {
        device(async () => { throw execError(`adb -s ${SERIAL} exec-out screencap -p`, "error: closed"); });

        await androidScreenshot(undefined, SERIAL);

        expect(calls().some((c) => c.includes("screencap -p /sdcard"))).toBe(true);
        expect(calls().some((c) => c.includes("pull"))).toBe(true);
    });

    it("does not fall back after a timeout: a second 30s wait on a hung device is the bug", async () => {
        device(async () => { throw execError(`adb -s ${SERIAL} exec-out screencap -p`, "", { killed: true, signal: "SIGTERM", code: null }); });

        const r = await androidScreenshot(undefined, SERIAL);

        expect(r.success).toBe(false);
        expect(calls().some((c) => c.includes("pull"))).toBe(false);
        expect(r.error).toMatch(/timed out/);
    });

    it("puts the device's own error before the command, so a 200-char truncation keeps it", async () => {
        execMock.mockImplementation(async (_file, args) => {
            if (args[0] === "version") return { stdout: "Android Debug Bridge version 1.0.41", stderr: "" };
            throw execError(`adb ${args.join(" ")}`, "error: device offline");
        });

        const r = await androidScreenshot(undefined, SERIAL);

        expect(r.success).toBe(false);
        expect(r.error!.indexOf("device offline")).toBeLessThan(r.error!.indexOf("adb -s"));
        expect(r.error!.slice(0, 200)).toContain("device offline");
    });

    it("tags no attached device as no_android_device", async () => {
        execMock.mockImplementation(async (_file, args) => {
            if (args[0] === "version") return { stdout: "Android Debug Bridge version 1.0.41", stderr: "" };
            if (args[0] === "devices") return { stdout: "List of devices attached\n\n", stderr: "" };
            return { stdout: "", stderr: "" };
        });

        const r = await androidScreenshot();

        expect(r.success).toBe(false);
        expect(r.failureKind).toBe("no_android_device");
    });
});
