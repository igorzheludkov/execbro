import { existsSync } from "fs";
import os from "os";
import path from "path";
import { execFileAsync } from "./exec.js";
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
    "`mounter auto-mount` is the documented route but fails on a stock machine — it tries to write into that root-owned Xcode directory.";

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
        return rows.map((r) => ({
            udid: r.Identifier ?? r.UniqueDeviceID ?? "",
            name: r.DeviceName ?? "iPhone",
            version: r.ProductVersion ?? "?",
            productType: r.ProductType ?? "?",
        })).filter((d) => d.udid);
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
    try {
        await execFileAsync(bin!, ["developer", "dvt", "screenshot", "--udid", udid, outputPath], {
            timeout: PMD3_TIMEOUT,
        });
        return { ok: true };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, error: PMD3_MISSING_ERROR };
        }
        const stderr = (error as { stderr?: string }).stderr ?? "";
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `${stderr.trim() || message}\n\n${DDI_HINT}` };
    }
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
