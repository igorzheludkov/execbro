import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mkdtempSync, existsSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

/**
 * iOS screen capture and UI-driver failures, as seen in production telemetry (2026-11-04..18). The fast iosScreenshot failures all came from a caller-supplied outputPath (missing folder); the driver failures never set a failure kind. No simulator contact: the exec layer is stubbed.
 */

type ExecFn = (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>;
const execMock = jest.fn<ExecFn>();
jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execMock,
    quoteForDeviceShell: (v: string) => `'${v}'`,
    execAsync: jest.fn(),
    withCancelableTimeout: jest.fn(),
}));

const { iosScreenshot, iosSwipe, iosKeyEvent, resetSimctlAvailableCache } = await import("../../core/ios.js");

const UDID = "F93612A3-0042-4BDC-855F-8CAB1BDD76C6";
let png: Buffer;
let simctlTargets: string[] = [];

function execError(cmd: string, stderr: string): Error {
    return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { cmd, stderr, code: 1, killed: false });
}

function simulator(opts: { screenshot?: (target: string) => Promise<void>; axe?: (args: string[]) => Promise<{ stdout: string; stderr: string }> } = {}) {
    execMock.mockImplementation(async (file, args) => {
        if (file === "xcrun" && args[1] === "io" && args[3] === "screenshot") {
            simctlTargets.push(args[4]);
            if (opts.screenshot) await opts.screenshot(args[4]);
            else writeFileSync(args[4], png);
            return { stdout: "", stderr: "" };
        }
        if (file === "axe" && opts.axe && args[0] !== "--version") return opts.axe(args);
        return { stdout: "", stderr: "" };
    });
}

beforeEach(async () => {
    execMock.mockReset();
    resetSimctlAvailableCache();
    simctlTargets = [];
    png = await sharp({ create: { width: 30, height: 60, channels: 3, background: "#00f" } }).png().toBuffer();
});

describe("iosScreenshot outputPath", () => {
    it("captures to a temp file, then creates the caller's folder and copies there", async () => {
        simulator();
        const out = path.join(mkdtempSync(path.join(os.tmpdir(), "ios-shot-")), "missing", "dir", "s.png");

        const r = await iosScreenshot(out, UDID);

        expect(r.success).toBe(true);
        expect(simctlTargets[0]).not.toBe(out);
        expect(existsSync(out)).toBe(true);
        expect(r.result).toBe(out);
    });

    it("still returns the screenshot when the copy fails, and says so", async () => {
        simulator();
        const blocker = path.join(mkdtempSync(path.join(os.tmpdir(), "ios-shot-")), "a-file");
        writeFileSync(blocker, "x");
        const out = path.join(blocker, "s.png");

        const r = await iosScreenshot(out, UDID);

        expect(r.success).toBe(true);
        expect(r.data).toBeDefined();
        expect(r.saveError).toContain(out);
    });

    it("puts simctl's stderr before the command", async () => {
        simulator({
            screenshot: async (target) => { throw execError(`xcrun simctl io ${UDID} screenshot ${target}`, "Invalid device: " + UDID); },
        });

        const r = await iosScreenshot(undefined, UDID);

        expect(r.success).toBe(false);
        expect(r.error!.slice(0, 200)).toContain("Invalid device");
        expect(r.error!.indexOf("Invalid device")).toBeLessThan(r.error!.indexOf("xcrun simctl"));
    });

    it("tags no booted simulator as no_ios_simulator", async () => {
        execMock.mockResolvedValue({ stdout: "", stderr: "" });

        const r = await iosScreenshot();

        expect(r.success).toBe(false);
        expect(r.failureKind).toBe("no_ios_simulator");
    });
});

describe("iOS UI driver failure kinds", () => {
    it("tags a missing AXe as driver_not_installed", async () => {
        execMock.mockImplementation(async (file) => {
            if (file === "axe") throw Object.assign(new Error("spawn axe ENOENT"), { code: "ENOENT" });
            return { stdout: "", stderr: "" };
        });

        const r = await iosSwipe(10, 10, 10, 100, { udid: UDID });

        expect(r.success).toBe(false);
        expect(r.failureKind).toBe("driver_not_installed");
    });

    it.each([
        ["swipe", () => iosSwipe(10, 10, 10, 100, { udid: UDID })],
        ["key event", () => iosKeyEvent(40, { udid: UDID })],
    ])("maps AXe's private-framework load failure on %s to driver_not_installed with a fix", async (_name, run) => {
        simulator({
            axe: async (args) => { throw execError(`axe ${args.join(" ")}`, "Error: Failed to load essential private frameworks: CoreSimulator"); },
        });

        const r = await run();

        expect(r.success).toBe(false);
        expect(r.failureKind).toBe("driver_not_installed");
        expect(r.error).toMatch(/xcode-select/);
        expect(r.error).toMatch(/brew upgrade/);
    });
});
