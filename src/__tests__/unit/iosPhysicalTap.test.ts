import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { existsSync } from "fs";

/**
 * HID taps on a USB iPhone (iOS 27+) through pymobiledevice3's
 * `universal-hid-service session`. No device contact: exec.js is mocked, and
 * that matters here because resolveBinary() finds the real
 * ~/.local/bin/pymobiledevice3 on a developer machine.
 */

type ExecOpts = { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number };
type Handler = (args: string[], opts: ExecOpts) => Promise<{ stdout: string; stderr: string }>;

const execAsyncMock = jest.fn<(file: string, args: string[], opts?: ExecOpts) => Promise<{ stdout: string; stderr: string }>>();
jest.unstable_mockModule("../../core/exec.js", () => ({ execFileAsync: execAsyncMock }));
jest.unstable_mockModule("../../core/ios.js", () => ({
    defaultScreenshotPath: () => "/tmp/unused.png",
    finalizeScreenshotFile: jest.fn(),
}));

const {
    toHidPoint,
    buildHidTapScript,
    versionAtLeast,
    physicalIosTap,
    capturePhysicalIosScreenshot,
    listPhysicalIosDevices,
    resolvePhysicalIosDevice,
    resetPmd3VersionCache,
    physicalIosOrientation,
    PMD3_HID_MIN_VERSION,
    PMD3_MISSING_ERROR,
} = await import("../../core/iosPhysical.js");

// A fresh udid per test: the per-phone queue is module state, and one test's
// hung session must not wedge the next test's queue.
let phone = { udid: "00008030-001D69C00192802E", name: "iPhone", version: "27.2.1", productType: "iPhone12,1" };
let testIndex = 0;

function useFakeTimers() {
    // fs/promises (the script file) settles through the real event loop.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
}

async function untilSessions(n: number) {
    while (sessionCalls().length < n) await new Promise((r) => setImmediate(r));
}

let pmd3Version = "11.32.0";
let session: Handler = async () => ({ stdout: "", stderr: "" });
let screenshot: Handler = async () => ({ stdout: "", stderr: "" });
let mounterList: Handler = async () => ({ stdout: "[]", stderr: "" });
let usbmux: Handler | null = null;
let displayInfo: Handler = async () => ({ stdout: "{}", stderr: "" });

function abortable(opts: ExecOpts, ms?: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        if (ms !== undefined) setTimeout(() => resolve({ stdout: "", stderr: "" }), ms);
        opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
}

function sessionCalls() {
    return execAsyncMock.mock.calls.filter(([, a]) => a.includes("session"));
}

beforeEach(() => {
    phone = { ...phone, udid: `00008030-TEST${++testIndex}`, version: "27.2.1" };
    resetPmd3VersionCache();
    execAsyncMock.mockReset();
    pmd3Version = "11.32.0";
    session = async () => ({ stdout: "", stderr: "" });
    screenshot = async () => ({ stdout: "", stderr: "" });
    mounterList = async () => ({ stdout: "[]", stderr: "" });
    usbmux = null;
    displayInfo = async () => ({ stdout: "{}", stderr: "" });
    execAsyncMock.mockImplementation(async (_file, args, opts = {}) => {
        if (args[0] === "version") return { stdout: `${pmd3Version}\n`, stderr: "" };
        if (args[0] === "usbmux") {
            if (usbmux) return usbmux(args, opts);
            return { stdout: JSON.stringify([{ DeviceName: phone.name, Identifier: phone.udid, ProductType: phone.productType, ProductVersion: phone.version }]), stderr: "" };
        }
        if (args.includes("session")) return session(args, opts);
        if (args.includes("screenshot")) return screenshot(args, opts);
        if (args[0] === "mounter") return mounterList(args, opts);
        if (args.includes("get-display-info")) return displayInfo(args, opts);
        return { stdout: "", stderr: "" };
    });
});

afterEach(() => {
    jest.useRealTimers();
});

describe("toHidPoint", () => {
    it("maps the spec's measured point", () => {
        // spec §2.2 recorded 55166,29878 for 697,817 on 828x1792; pymobiledevice3's own formula
        // (round(px * 65535 / size)) gives 55167 for x. One HID unit is 0.013 px.
        expect(toHidPoint(697, 817, { width: 828, height: 1792, scaleFactor: 1 })).toEqual({ x: 55167, y: 29878 });
    });
    it("scales delivered px back to raw before normalising", () => {
        expect(toHidPoint(348.5, 408.5, { width: 828, height: 1792, scaleFactor: 2 })).toEqual({ x: 55167, y: 29878 });
    });
    it("refuses a point outside the frame", () => {
        expect(toHidPoint(-1, 10, { width: 828, height: 1792, scaleFactor: 1 })).toHaveProperty("error");
        expect(toHidPoint(10, 1793, { width: 828, height: 1792, scaleFactor: 1 })).toHaveProperty("error");
    });
    const LANDSCAPE = { width: 1792, height: 828, scaleFactor: 1 };
    it("maps a landscape point turned rot270 (measured 2026-11-14: the iCloud banner's close button)", () => {
        expect(toHidPoint(1457, 224, LANDSCAPE, "rot270")).toEqual({ x: 47806, y: 53284 });
    });
    it("maps a landscape point turned rot90 the opposite way (verified on device)", () => {
        expect(toHidPoint(1457, 224, LANDSCAPE, "rot90")).toEqual({ x: 17729, y: 12251 });
    });
    it("refuses a landscape frame whose rotation is unknown", () => {
        expect((toHidPoint(10, 10, LANDSCAPE) as { error: string }).error).toMatch(/landscape/i);
        expect((toHidPoint(10, 10, LANDSCAPE, "rot0") as { error: string }).error).toMatch(/landscape/i);
    });
});

describe("buildHidTapScript", () => {
    it("settles 0.5 s, then taps", () => {
        expect(buildHidTapScript({ x: 100, y: 200 })).toBe("sleep 0.5\ntap 100 200\n");
    });
    it("holds with a stationary drag", () => {
        expect(buildHidTapScript({ x: 100, y: 200 }, 800)).toBe("sleep 0.5\ndrag 100 200 100 200 16 0.8\n");
    });
});

describe("versionAtLeast", () => {
    it.each([
        ["11.32.0", true],
        ["11.33.1.dev4+g52a51c5c9", true],
        ["12.0.0", true],
        ["11.31.9", false],
        ["11.10.3", false],
    ])("%s >= 11.32.0 is %s", (v, ok) => expect(versionAtLeast(v as string, PMD3_HID_MIN_VERSION)).toBe(ok));
});

describe("physicalIosTap", () => {
    it("runs a session script over --native with the udid in the env and an abort signal", async () => {
        let script = "";
        session = async (args) => {
            script = (await import("fs")).readFileSync(args[args.indexOf("--script") + 1], "utf8");
            return { stdout: "", stderr: "" };
        };
        await expect(physicalIosTap(phone, { x: 1, y: 2 })).resolves.toEqual({ success: true });
        const [, args, opts] = sessionCalls()[0];
        expect(args.slice(0, 5)).toEqual(["developer", "core-device", "universal-hid-service", "session", "--native"]);
        expect(args).toContain("--script");
        expect(opts?.env?.PYMOBILEDEVICE3_UDID).toBe(phone.udid);
        expect(opts?.signal).toBeDefined();
        expect(opts?.timeout).toBeUndefined();
        expect(script).toBe("sleep 0.5\ntap 1 2\n");
    });

    it("refuses below iOS 27 without running a gesture", async () => {
        const r = await physicalIosTap({ ...phone, version: "18.6.2" }, { x: 1, y: 2 });
        expect(r).toEqual({ success: false, error: expect.stringMatching(/iOS 27/) });
        expect(sessionCalls()).toHaveLength(0);
    });

    it("refuses an old pymobiledevice3 with the upgrade line", async () => {
        pmd3Version = "11.10.3";
        const r = await physicalIosTap(phone, { x: 1, y: 2 });
        expect(r).toEqual({ success: false, error: expect.stringContaining("pipx upgrade pymobiledevice3") });
        expect(sessionCalls()).toHaveLength(0);
    });

    it("returns PMD3_MISSING_ERROR when pymobiledevice3 is not installed", async () => {
        execAsyncMock.mockImplementation(async () => {
            throw Object.assign(new Error("spawn pymobiledevice3 ENOENT"), { code: "ENOENT" });
        });
        await expect(physicalIosTap(phone, { x: 1, y: 2 })).resolves.toEqual({ success: false, error: PMD3_MISSING_ERROR });
    });

    it("names the mounted image when the touch service is missing", async () => {
        session = async () => {
            throw Object.assign(new Error("Command failed"), { stderr: "ERROR Failed to start service. Possible reasons are: ..." });
        };
        mounterList = async () => ({ stdout: '[{"PersonalizedImageVersionInfo": {"ProductBuildVersion": "17A400"}}]', stderr: "" });
        const r = await physicalIosTap(phone, { x: 1, y: 2 });
        expect(r.success).toBe(false);
        const error = (r as { error: string }).error;
        expect(error).toMatch(/17A400/);
        expect(error).toMatch(/Xcode 27/);
        expect(error).toMatch(/umount-personalized/);
    });

    it("says what to check when the Xcode 27 image is already mounted", async () => {
        session = async () => {
            throw Object.assign(new Error("Command failed"), { stderr: "ERROR Failed to start service. Possible reasons are: ..." });
        };
        mounterList = async () => ({ stdout: '[{"PersonalizedImageVersionInfo": {"ProductBuildVersion": "27B52"}}]', stderr: "" });
        const error = ((await physicalIosTap(phone, { x: 1, y: 2 })) as { error: string }).error;
        expect(error).toMatch(/27B52/);
        expect(error).not.toMatch(/umount-personalized/);
        expect(error).toMatch(/Developer Mode/);
        expect(error).toMatch(/Failed to start service/);
    });

    it("frees the phone when a killed session's pipes stay open (a grandchild holding them)", async () => {
        useFakeTimers();
        session = () => new Promise(() => undefined);
        const pending = physicalIosTap(phone, { x: 1, y: 2 });
        await untilSessions(1);
        await jest.advanceTimersByTimeAsync(16000);
        await expect(pending).resolves.toEqual({ success: false, error: expect.stringMatching(/did not answer within 15 s/) });
    });

    it("kills a hung session at 15 s and says the touch may have landed", async () => {
        useFakeTimers();
        session = async (_a, opts) => abortable(opts);
        const pending = physicalIosTap(phone, { x: 1, y: 2 });
        await untilSessions(1);
        await jest.advanceTimersByTimeAsync(15000);
        const r = await pending;
        expect(r).toEqual({ success: false, error: expect.stringMatching(/did not answer within 15 s/) });
        expect((r as { error: string }).error).toMatch(/screenshot before retrying/);
        expect(sessionCalls()[0][2]?.signal?.aborted).toBe(true);
    });

    it("gives a long press its hold time on top of the deadline", async () => {
        useFakeTimers();
        session = async (_a, opts) => abortable(opts);
        const pending = physicalIosTap(phone, { x: 1, y: 2 }, 13000);
        await untilSessions(1);
        await jest.advanceTimersByTimeAsync(15000);
        expect(sessionCalls()[0][2]?.signal?.aborted).toBe(false);
        await jest.advanceTimersByTimeAsync(13000);
        await expect(pending).resolves.toEqual({ success: false, error: expect.stringMatching(/did not answer within 28 s/) });
    });

    it("starts the deadline when the queued task starts, not at enqueue", async () => {
        useFakeTimers();
        let n = 0;
        // Second tap starts at 14 s and needs 2 s: a deadline counted from enqueue would kill it at 15 s.
        session = async (_a, opts) => abortable(opts, n++ === 0 ? 14000 : 2000);
        const first = physicalIosTap(phone, { x: 1, y: 2 });
        const second = physicalIosTap(phone, { x: 3, y: 4 });
        await untilSessions(1);
        await jest.advanceTimersByTimeAsync(14000);
        await untilSessions(2);
        await jest.advanceTimersByTimeAsync(2000);
        await expect(first).resolves.toEqual({ success: true });
        await expect(second).resolves.toEqual({ success: true });
    });

    it("runs a tap and a capture on one phone one after the other", async () => {
        const events: string[] = [];
        session = async () => {
            events.push("tap:start");
            await new Promise((r) => setTimeout(r, 30));
            events.push("tap:end");
            return { stdout: "", stderr: "" };
        };
        screenshot = async () => {
            events.push("shot:start");
            await new Promise((r) => setTimeout(r, 5));
            events.push("shot:end");
            return { stdout: "", stderr: "" };
        };
        await Promise.all([physicalIosTap(phone, { x: 1, y: 2 }), capturePhysicalIosScreenshot(phone.udid, "/tmp/x.png")]);
        expect(events).toEqual(["tap:start", "tap:end", "shot:start", "shot:end"]);
    });

    it("re-reads the version after a refusal, so an upgrade takes effect without a restart", async () => {
        pmd3Version = "11.10.3";
        expect((await physicalIosTap(phone, { x: 1, y: 2 })).success).toBe(false);
        pmd3Version = "11.32.0";
        await expect(physicalIosTap(phone, { x: 1, y: 2 })).resolves.toEqual({ success: true });
    });

    it("captures an iOS 15/16 phone over plain usbmux, not --native (remotepairingd is iOS 17+)", async () => {
        phone = { ...phone, version: "15.8.8" };
        await listPhysicalIosDevices();
        await capturePhysicalIosScreenshot(phone.udid, "/tmp/x.png");
        const [, args] = execAsyncMock.mock.calls.find(([, a]) => a.includes("screenshot"))!;
        expect(args).toEqual(["developer", "dvt", "screenshot", "--udid", phone.udid, "/tmp/x.png"]);
    });

    it("captures over --native with the udid in the env", async () => {
        await listPhysicalIosDevices();
        await capturePhysicalIosScreenshot(phone.udid, "/tmp/x.png");
        const [, args, opts] = execAsyncMock.mock.calls.find(([, a]) => a.includes("screenshot"))!;
        expect(args).toEqual(["developer", "dvt", "screenshot", "--native", "/tmp/x.png"]);
        expect(opts?.env?.PYMOBILEDEVICE3_UDID).toBe(phone.udid);
        expect(opts?.signal).toBeDefined();
    });

    it("deletes the script file whether the session succeeds or fails", async () => {
        const paths: string[] = [];
        session = async (args) => {
            paths.push(args[args.indexOf("--script") + 1]);
            if (paths.length === 2) throw Object.assign(new Error("boom"), { stderr: "boom" });
            return { stdout: "", stderr: "" };
        };
        await physicalIosTap(phone, { x: 1, y: 2 });
        await physicalIosTap(phone, { x: 1, y: 2 });
        expect(paths).toHaveLength(2);
        expect(paths.every((p) => !existsSync(p))).toBe(true);
    });
});

describe("listPhysicalIosDevices", () => {
    it("gives up on a hung usbmux listing after 10 s instead of 30", async () => {
        useFakeTimers();
        usbmux = async (_a, opts) => abortable(opts);
        const pending = listPhysicalIosDevices();
        await jest.advanceTimersByTimeAsync(11000);
        await expect(pending).resolves.toEqual([]);
    });
});

describe("resolvePhysicalIosDevice", () => {
    it("matches nothing for a blank hint, without listing", async () => {
        phone = { ...phone, name: "My iPhone" };
        await expect(resolvePhysicalIosDevice(" ")).resolves.toBeNull();
        await expect(resolvePhysicalIosDevice("")).resolves.toBeNull();
        expect(execAsyncMock).not.toHaveBeenCalled();
    });
});

describe("physicalIosOrientation", () => {
    it("reads the built-in display's rotation over --native", async () => {
        displayInfo = async () => ({ stdout: JSON.stringify({ displays: [{ external: false, currentOrientation: "rot270" }] }), stderr: "" });
        await expect(physicalIosOrientation(phone.udid)).resolves.toBe("rot270");
        const call = execAsyncMock.mock.calls.find(([, a]) => a.includes("get-display-info"))!;
        expect(call[1]).toContain("--native");
        expect(call[2]?.env?.PYMOBILEDEVICE3_UDID).toBe(phone.udid);
    });
    it("is null when the phone does not answer", async () => {
        displayInfo = async () => {
            throw Object.assign(new Error("Command failed"), { stderr: "boom" });
        };
        await expect(physicalIosOrientation(phone.udid)).resolves.toBeNull();
    });
});
