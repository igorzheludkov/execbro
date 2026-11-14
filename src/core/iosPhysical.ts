import { existsSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import os from "os";
import path from "path";
import { execFileAsync } from "./exec.js";
import { createSerialQueue, type SerialQueue } from "./serialQueue.js";
import { defaultScreenshotPath, finalizeScreenshotFile } from "./ios.js";
import type { iOSResult } from "./ios.js";

// pymobiledevice3 talks to the phone over usbmux; every call re-negotiates the
// lockdown session, so these are slower than a simctl call, not comparable.
const PMD3_TIMEOUT = 30000;

export interface PhysicalIosDevice {
    udid: string;
    name: string;
    version: string;
    productType: string;
}

export const PMD3_MISSING_ERROR =
    "pymobiledevice3 is not installed. Physical iOS devices are reached over usbmux, which simctl cannot do.\n" +
    "Install it with:  brew install pipx && pipx install pymobiledevice3\n" +
    "(or, if you use uv:  uv tool install pymobiledevice3)\n" +
    "Not `pip install` — modern macOS refuses that with externally-managed-environment.";

export const DDI_HINT =
    "If this says the developer service is unavailable, the DeveloperDiskImage is not mounted. Mount it with:\n" +
    "  pymobiledevice3 mounter mount-developer \\\n" +
    "    \"$X/DeveloperDiskImage.dmg\" \"$X/DeveloperDiskImage.dmg.signature\"\n" +
    "where X is the closest match under /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/DeviceSupport/.\n" +
    "`mounter auto-mount` is the documented route but fails on a stock machine — it tries to write into that root-owned Xcode directory.\n" +
    "That applies to iOS 16 and below; iOS 17+ uses the personalized image (`pymobiledevice3 mounter auto-mount`).";

/** First release with #2003 (no dtremotedisplayd abort, no stuck indicator). Spec §2.2. */
export const PMD3_HID_MIN_VERSION = "11.32.0";
/** The phone refuses remote control below this: CoreDeviceError 9021. Spec §2.1. */
export const IOS_HID_MIN_MAJOR = 27;
export const HID_SESSION_DEADLINE_MS = 15000;
export const PHYSICAL_CAPTURE_DEADLINE_MS = 10000;
const PMD3_SHORT_DEADLINE_MS = 5000;

// pipx installs into ~/.local/bin, which a GUI-launched MCP server often does
// not have on PATH. Resolving once and caching keeps the fallback off the hot
// path without re-stat'ing on every capture.
let binaryCache: string | null | undefined;

function resolveBinary(): string | null {
    if (binaryCache !== undefined) return binaryCache;
    const fallback = path.join(os.homedir(), ".local", "bin", "pymobiledevice3");
    binaryCache = existsSync(fallback) ? fallback : "pymobiledevice3";
    return binaryCache;
}

/**
 * Every physical iOS device attached over USB.
 *
 * Returns an empty list rather than throwing when pymobiledevice3 is absent —
 * callers treat "no physical devices" and "cannot see physical devices" the
 * same way, and the actionable message belongs on the capture attempt, not on
 * a discovery listing that runs alongside simulators.
 */
export async function listPhysicalIosDevices(): Promise<PhysicalIosDevice[]> {
    const bin = resolveBinary();
    if (!bin) return [];
    try {
        const { stdout } = await execFileAsync(bin, ["usbmux", "list"], { timeout: PMD3_TIMEOUT });
        const rows = JSON.parse(stdout) as Array<Record<string, string>>;
        const devices = rows.map((r) => ({
            udid: r.Identifier ?? r.UniqueDeviceID ?? "",
            name: r.DeviceName ?? "iPhone",
            version: r.ProductVersion ?? "?",
            productType: r.ProductType ?? "?",
        })).filter((d) => d.udid);
        for (const d of devices) knownPhysicalUdids.add(d.udid);
        return devices;
    } catch {
        return [];
    }
}

/**
 * Match a user-supplied hint against attached physical devices.
 *
 * Deliberately the same shape of match `resolveDeviceTarget` uses for
 * simulators (exact identifier, then name substring) so a hint that works for
 * one kind of device does not silently mean something else for the other.
 */
export async function resolvePhysicalIosDevice(hint: string): Promise<PhysicalIosDevice | null> {
    const devices = await listPhysicalIosDevices();
    const h = hint.toLowerCase();
    return (
        devices.find((d) => d.udid.toLowerCase() === h) ??
        devices.find((d) => d.name.toLowerCase().includes(h)) ??
        null
    );
}

/**
 * Capture the framebuffer of a physical device into `outputPath`.
 *
 * Goes through DVT (`com.apple.instruments.server.services.screenshot`), which
 * needs a mounted DeveloperDiskImage but no tunnel and no root — so unlike HID
 * injection it works all the way back to iOS 15.
 */
export async function capturePhysicalIosScreenshot(
    udid: string,
    outputPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const bin = resolveBinary();
    // --native rides remoted's tunnel. Without it a cold call on iOS 17+ falls
    // back to the userspace tunnel (measured 3.4 s, and the one with upstream
    // hang reports). Shares the phone's queue so a capture never overlaps a tap.
    return withPhoneLock(udid, async () => {
        const run = await runPmd3(bin!, ["developer", "dvt", "screenshot", "--native", outputPath], udid, PHYSICAL_CAPTURE_DEADLINE_MS);
        if (run.ok) return { ok: true as const };
        if (run.missing) return { ok: false as const, error: PMD3_MISSING_ERROR };
        if (run.aborted) {
            return { ok: false as const, error: `The phone did not return a screenshot within ${PHYSICAL_CAPTURE_DEADLINE_MS / 1000} s and the capture was killed (a RemoteXPC hang). Retry; if it keeps hanging, unplug and replug the phone.` };
        }
        return { ok: false as const, error: `${run.stderr || run.message}\n\n${DDI_HINT}` };
    });
}

/**
 * Screenshot a physical device, in the exact shape `iosScreenshot` returns.
 *
 * Same downscale and metadata as the simulator path, because it is literally
 * the same code — only the capture differs.
 */
export async function physicalIosScreenshot(
    udid: string,
    outputPath?: string,
): Promise<iOSResult> {
    const finalOutputPath = outputPath || defaultScreenshotPath("ios-device-screenshot");
    const captured = await capturePhysicalIosScreenshot(udid, finalOutputPath);
    if (!captured.ok) return { success: false, error: captured.error };
    try {
        return await finalizeScreenshotFile(finalOutputPath);
    } catch (error) {
        return {
            success: false,
            error: `Failed to process screenshot: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

// ---------------------------------------------------------------------------
// HID touch (iOS 27+), through `universal-hid-service session`. Spec §2.2.
// ---------------------------------------------------------------------------

const knownPhysicalUdids = new Set<string>();

/** True for any udid `listPhysicalIosDevices` has returned in this process. */
export function isPhysicalIosUdid(udid: string): boolean {
    return knownPhysicalUdids.has(udid);
}

const phoneQueues = new Map<string, SerialQueue>();

/**
 * One queue per phone. Two RemoteXPC sessions on one device evict each
 * other's RSD connection, so taps and captures on a phone run one at a time.
 */
export function withPhoneLock<T>(udid: string, task: () => Promise<T>): Promise<T> {
    let queue = phoneQueues.get(udid);
    if (!queue) {
        queue = createSerialQueue();
        phoneQueues.set(udid, queue);
    }
    return queue.run(task);
}

type Pmd3Run =
    | { ok: true; stdout: string }
    | { ok: false; missing: boolean; aborted: boolean; stderr: string; message: string };

/**
 * Run pymobiledevice3 with the phone in the env and a hard deadline. An
 * AbortSignal, not execFile's `timeout`: only the signal path in
 * execFileAsync escalates SIGTERM to SIGKILL, and a RemoteXPC read blocked
 * in the kernel is the case SIGTERM may not end.
 */
async function runPmd3(bin: string, args: string[], udid: string, deadlineMs: number): Promise<Pmd3Run> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
        const { stdout } = await execFileAsync(bin, args, {
            signal: controller.signal,
            env: { ...process.env, PYMOBILEDEVICE3_UDID: udid },
        });
        return { ok: true, stdout };
    } catch (error) {
        return {
            ok: false,
            missing: (error as NodeJS.ErrnoException).code === "ENOENT",
            aborted: controller.signal.aborted,
            stderr: ((error as { stderr?: string }).stderr ?? "").trim(),
            message: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Delivered-screenshot px -> HID 0..65535 (0 = left/top), against the raw
 * frame of a physical capture: `hid = round(raw * 65535 / size)`.
 */
export function toHidPoint(
    x: number,
    y: number,
    frame: { width: number; height: number; scaleFactor: number },
): { x: number; y: number } | { error: string } {
    if (frame.width > frame.height) {
        return { error: "Landscape is not supported on a physical iPhone yet: the HID origin was only measured in portrait. Rotate the phone to portrait." };
    }
    const scale = frame.scaleFactor || 1;
    const rawX = x * scale;
    const rawY = y * scale;
    if (rawX < 0 || rawY < 0 || rawX > frame.width || rawY > frame.height) {
        const w = Math.round(frame.width / scale);
        const h = Math.round(frame.height / scale);
        return { error: `(${x}, ${y}) is outside the screen (${w}x${h} in screenshot pixels). Take a screenshot and use coordinates from it.` };
    }
    return {
        x: Math.round((rawX * 65535) / frame.width),
        y: Math.round((rawY * 65535) / frame.height),
    };
}

/**
 * The session script. `sleep 0.5` first: backboardd drops a touch sent before
 * the stream authenticates (0.3 s failed 2/2 on an iPhone 11), and 11.32.0 has
 * no built-in settle (#2039). A stationary drag is CONTACT repeated, then
 * RELEASE: a hold.
 */
export function buildHidTapScript(point: { x: number; y: number }, durationMs?: number): string {
    const gesture = durationMs === undefined
        ? `tap ${point.x} ${point.y}`
        : `drag ${point.x} ${point.y} ${point.x} ${point.y} ${Math.max(2, Math.round(durationMs / 50))} ${durationMs / 1000}`;
    return `sleep 0.5\n${gesture}\n`;
}

/** Numeric compare of the leading major.minor.patch; suffixes like `.dev4+g...` are ignored. */
export function versionAtLeast(version: string, floor: string): boolean {
    const parse = (v: string) => (v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/) ?? []).slice(1, 4).map((n) => Number(n ?? 0));
    const a = parse(version);
    const b = parse(floor);
    if (a.length === 0) return false;
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return true;
}

let pmd3VersionCache: string | null | undefined;

export function resetPmd3VersionCache(): void {
    pmd3VersionCache = undefined;
}

async function pmd3Version(bin: string, udid: string): Promise<{ version: string } | { missing: true } | { unknown: string }> {
    if (pmd3VersionCache) return { version: pmd3VersionCache };
    const run = await runPmd3(bin, ["version"], udid, PMD3_SHORT_DEADLINE_MS);
    if (!run.ok) return run.missing ? { missing: true } : { unknown: run.stderr || run.message };
    const line = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    pmd3VersionCache = line;
    return { version: line };
}

async function mountedImageBuild(bin: string, udid: string): Promise<string | null> {
    const run = await runPmd3(bin, ["mounter", "list"], udid, PMD3_SHORT_DEADLINE_MS);
    if (!run.ok) return null;
    return run.stdout.match(/"ProductBuildVersion":\s*"([^"]+)"/)?.[1] ?? null;
}

/**
 * A real touch on a USB iPhone running iOS 27+. `point` is in HID units
 * (see toHidPoint); `durationMs` makes it a long press.
 */
export async function physicalIosTap(
    device: PhysicalIosDevice,
    point: { x: number; y: number },
    durationMs?: number,
): Promise<{ success: true } | { success: false; error: string }> {
    const major = parseInt(device.version, 10);
    if (!(major >= IOS_HID_MIN_MAJOR)) {
        return {
            success: false,
            error: `tap on a physical iPhone needs iOS ${IOS_HID_MIN_MAJOR} or later; this device runs iOS ${device.version}. Older iOS has no host touch injection. Use a simulator.`,
        };
    }
    const bin = resolveBinary()!;
    return withPhoneLock(device.udid, async () => {
        const v = await pmd3Version(bin, device.udid);
        if ("missing" in v) return { success: false as const, error: PMD3_MISSING_ERROR };
        if ("unknown" in v) return { success: false as const, error: `Could not read the pymobiledevice3 version: ${v.unknown}` };
        if (!versionAtLeast(v.version, PMD3_HID_MIN_VERSION)) {
            return {
                success: false as const,
                error: `pymobiledevice3 ${v.version} is too old for physical-device taps (${PMD3_HID_MIN_VERSION} or later). Upgrade with: pipx upgrade pymobiledevice3`,
            };
        }

        const scriptPath = path.join(os.tmpdir(), `execbro-hid-${device.udid}-${Date.now()}.txt`);
        await writeFile(scriptPath, buildHidTapScript(point, durationMs));
        const deadlineMs = HID_SESSION_DEADLINE_MS + (durationMs ?? 0);
        try {
            // ponytail: one stream per tap (~2.5 s). A long-lived helper holding one stream per phone makes a tap one HID report; build it when tap latency on a phone is the complaint, and give it a per-command deadline that kills and respawns it, because long-lived RemoteXPC connections are where pymobiledevice3 hangs (#1446, #1583, #2068).
            const run = await runPmd3(
                bin,
                ["developer", "core-device", "universal-hid-service", "session", "--native", "--script", scriptPath],
                device.udid,
                deadlineMs,
            );
            if (run.ok) return { success: true as const };
            if (run.missing) return { success: false as const, error: PMD3_MISSING_ERROR };
            if (run.aborted) {
                // Never retried: a touch that did land, sent again, is a double tap.
                return {
                    success: false as const,
                    error: `The HID session did not answer within ${deadlineMs / 1000} s and was killed (a RemoteXPC hang). The touch may or may not have landed: take a screenshot before retrying.`,
                };
            }
            if (/Failed to start service/i.test(run.stderr)) {
                const build = await mountedImageBuild(bin, device.udid);
                return {
                    success: false as const,
                    error:
                        `The phone's touch service is missing from the mounted developer disk image${build ? ` (build ${build})` : ""}. It comes from the Xcode 27 image. ` +
                        "Install Xcode 27, or quit Xcode (an open Xcode 26 remounts its own image within a second), then run " +
                        "`pymobiledevice3 mounter umount-personalized` and `pymobiledevice3 mounter auto-mount`, and check `pymobiledevice3 mounter list`. " +
                        "Developer Mode must be on.",
                };
            }
            return { success: false as const, error: `HID tap failed: ${run.stderr || run.message}` };
        } finally {
            await unlink(scriptPath).catch(() => undefined);
        }
    });
}
