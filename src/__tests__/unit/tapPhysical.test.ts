import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { readFileSync } from "fs";
import sharp from "sharp";

/**
 * tap() on a USB iPhone running iOS 27+. iosPhysical.ts runs for real against
 * a mocked exec.js, so the coordinate math, the script and the routing are
 * the production code; only pymobiledevice3 itself is faked.
 */

const PHONE_UDID = "00008030-001D69C00192802E";
let phoneVersion = "27.2.1";
const usbmux = () => JSON.stringify([
    { DeviceName: "iPhone", Identifier: PHONE_UDID, ProductType: "iPhone12,1", ProductVersion: phoneVersion },
]);

const width = 828;
const height = 1792;
// Two halves, so the frame is not near-uniform (that would read as a sleeping screen).
const PICTURE = await sharp({ create: { width, height, channels: 3, background: "#000" } })
    .composite([{ input: await sharp({ create: { width, height: height / 2, channels: 3, background: "#fff" } }).png().toBuffer(), top: 0, left: 0 }])
    .png()
    .toBuffer();
const BLANK = await sharp({ create: { width, height, channels: 3, background: "#000" } }).png().toBuffer();

let frame = PICTURE;
let screenshotError: string | null = null;
const calls: Array<{ file: string; args: string[] }> = [];
const scripts: string[] = [];

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[]) => {
        calls.push({ file, args });
        if (args[0] === "usbmux") return { stdout: usbmux(), stderr: "" };
        if (args[0] === "version") return { stdout: "11.32.0\n", stderr: "" };
        if (args.includes("screenshot")) {
            if (screenshotError) throw Object.assign(new Error("Command failed"), { stderr: screenshotError });
            await sharp(frame).toFile(args[args.length - 1]);
            return { stdout: "", stderr: "" };
        }
        if (args.includes("session")) {
            scripts.push(readFileSync(args[args.indexOf("--script") + 1], "utf8"));
            return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
    },
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T>(p: Promise<T>) => p,
}));

type Resolved =
    | { ok: true; target: { platform: "ios"; iosUdid?: string; deviceName: string; source: string } }
    | { ok: false; error: { code: string; message: string } };
let resolved: Resolved = { ok: false, error: { code: "DEVICE_NOT_FOUND", message: "No simulator or emulator matches" } };

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: async () => resolved,
    formatResolverError: (e: { message: string }) => e.message,
}));

jest.unstable_mockModule("../../pro/verifyAction.js", () => ({
    captureScreenshot: async () => null,
    verifyAndCapture: async () => ({
        screenshot: { image: "base64", width, height, scaleFactor: 1 },
        verification: { meaningful: true, explanation: "" },
    }),
    burstCaptureAndVerify: async () => ({ screenshot: undefined, verification: undefined }),
    drawTapMarker: async (b: Buffer) => b,
    settleAndDiff: async () => null,
}));

const { tap } = await import("../../pro/tap.js");
const { outcomeHintFor } = await import("../../pro/physicalTap.js");
const { toHidPoint } = await import("../../core/iosPhysical.js");
const { connectedApps } = await import("../../core/state.js");

const usbmuxCalls = () => calls.filter((c) => c.args[0] === "usbmux").length;

beforeEach(() => {
    phoneVersion = "27.2.1";
    connectedApps.clear();
    frame = PICTURE;
    screenshotError = null;
    calls.length = 0;
    scripts.length = 0;
    resolved = { ok: false, error: { code: "DEVICE_NOT_FOUND", message: "No simulator or emulator matches" } };
});

describe("tap on a physical iPhone", () => {
    it("taps a named phone by coordinates", async () => {
        const r = await tap({ x: 697, y: 817, device: PHONE_UDID });
        const hid = toHidPoint(697, 817, { width, height, scaleFactor: 1 }) as { x: number; y: number };
        expect(r).toMatchObject({ success: true, method: "device-hid", platform: "ios", device: "iPhone", convertedTo: { ...hid, unit: "hid" } });
        expect(scripts).toEqual([`sleep 0.5\ntap ${hid.x} ${hid.y}\n`]);
    });

    it("takes the same path with native: true", async () => {
        const r = await tap({ x: 697, y: 817, device: PHONE_UDID, native: true });
        expect(r).toMatchObject({ success: true, method: "device-hid" });
        expect(scripts).toHaveLength(1);
    });

    it("taps the phone an RN app runs on when the resolver fell back to the registry", async () => {
        resolved = { ok: true, target: { platform: "ios", deviceName: "iPhone", source: "default" } };
        const r = await tap({ x: 697, y: 817 });
        expect(r).toMatchObject({ success: true, method: "device-hid" });
    });

    it("keeps MULTIPLE_DEVICES_MATCH and never asks pymobiledevice3", async () => {
        resolved = { ok: false, error: { code: "MULTIPLE_DEVICES_MATCH", message: "Multiple devices available." } };
        const r = await tap({ x: 697, y: 817, device: "iPhone" });
        expect(r.success).toBe(false);
        expect(r.error).toBe("Multiple devices available.");
        expect(calls).toHaveLength(0);
    });

    it("keeps the resolver error when no device was named", async () => {
        resolved = { ok: false, error: { code: "NO_DEVICES_FOUND", message: "No devices found." } };
        const r = await tap({ x: 697, y: 817 });
        expect(r.error).toBe("No devices found.");
        expect(usbmuxCalls()).toBe(0);
    });

    it("reports a long press", async () => {
        const r = await tap({ x: 697, y: 817, device: PHONE_UDID, duration: 800 });
        expect(scripts[0]).toMatch(/^sleep 0\.5\ndrag (\d+) (\d+) \1 \2 16 0\.8\n$/);
        expect(r.longPress).toBeDefined();
    });

    it("refuses a testID on a phone and points at screenshot", async () => {
        const r = await tap({ testID: "login-btn", device: PHONE_UDID });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/coordinate taps only/);
        expect(r.error).toMatch(/screenshot/);
        expect(scripts).toHaveLength(0);
    });

    it("sends no touch when the before-frame is blank (screen off)", async () => {
        frame = BLANK;
        const r = await tap({ x: 697, y: 817, device: PHONE_UDID });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/screen is off/);
        expect(scripts).toHaveLength(0);
    });

    it("refuses a phone below iOS 27 before capturing anything", async () => {
        phoneVersion = "18.6.2";
        const r = await tap({ testID: "login-btn", device: PHONE_UDID });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/iOS 27/);
        expect(calls.some((c) => c.args.includes("screenshot"))).toBe(false);
    });

    it("surfaces the capture's own error", async () => {
        screenshotError = "ERROR InvalidServiceError 17A400";
        const r = await tap({ x: 697, y: 817, device: PHONE_UDID });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/17A400/);
        expect(scripts).toHaveLength(0);
    });
});

function app(id: string, deviceName: string, simulatorUdid?: string) {
    connectedApps.set(id, { deviceInfo: { deviceName }, platform: "ios", ...(simulatorUdid && { simulatorUdid }) } as never);
}

describe("outcomeHintFor", () => {
    it("maps a phone UDID to the RN app running on that phone", async () => {
        app("phone-app", "iPhone");
        await expect(outcomeHintFor(PHONE_UDID)).resolves.toBe("iPhone");
    });
    it("keeps the UDID when the only matching app is a simulator's, so its activity is not credited to the phone", async () => {
        app("sim-app", "iPhone 17 Pro", "F93612A3-0042-4BDC-855F-8CAB1BDD76C6");
        await expect(outcomeHintFor(PHONE_UDID)).resolves.toBe(PHONE_UDID);
    });
    it("leaves a simulator UUID and a plain name alone without asking pymobiledevice3", async () => {
        await expect(outcomeHintFor("F93612A3-0042-4BDC-855F-8CAB1BDD76C6")).resolves.toBe("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");
        await expect(outcomeHintFor("iPhone 17")).resolves.toBe("iPhone 17");
        await expect(outcomeHintFor(undefined)).resolves.toBeUndefined();
        expect(usbmuxCalls()).toBe(0);
    });
});
