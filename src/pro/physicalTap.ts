import type { ResolveResult } from "../core/deviceResolver.js";
import {
    IOS_HID_MIN_MAJOR,
    physicalIosScreenshot,
    physicalIosTap,
    resolvePhysicalIosDevice,
    toHidPoint,
    type PhysicalIosDevice,
} from "../core/iosPhysical.js";
import { isNearUniform } from "../core/blankFrame.js";
import { connectedApps } from "../core/state.js";
import { verifyAndCapture } from "./verifyAction.js";
import {
    buildLongPressReport,
    formatTapFailure,
    formatTapSuccess,
    type TapOptions,
    type TapQuery,
    type TapResult,
} from "./tap.js";

/**
 * The USB iPhone a tap should go to, or null. Only when the simctl/adb
 * resolver could not name a target and the caller named one, or when it fell
 * back to an RN app that has no simulator behind it. Never on an ambiguity:
 * two booted simulators plus a charging phone must not tap the phone.
 */
export async function physicalTargetFor(resolved: ResolveResult, device?: string): Promise<PhysicalIosDevice | null> {
    if (!resolved.ok) {
        if (!device) return null;
        if (resolved.error.code !== "DEVICE_NOT_FOUND" && resolved.error.code !== "NO_DEVICES_FOUND") return null;
        return resolvePhysicalIosDevice(device).catch(() => null);
    }
    if (resolved.target.platform !== "ios" || resolved.target.iosUdid) return null;
    return resolvePhysicalIosDevice(device ?? resolved.target.deviceName).catch(() => null);
}

const PHYSICAL_UDID = /^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$/i;

/**
 * The device hint the action outcome should use. The outcome finds the RN app
 * by name, simulator UDID or adb serial, so a phone's UDID becomes its name.
 * Anything not shaped like a phone UDID passes through without a pymobiledevice3 call.
 */
export async function outcomeHintFor(device?: string): Promise<string | undefined> {
    if (!device || !PHYSICAL_UDID.test(device)) return device;
    const phone = await resolvePhysicalIosDevice(device).catch(() => null);
    if (!phone) return device;
    // The outcome substring-matches names, and a phone is often just "iPhone":
    // hand over the name only when an app with exactly that name runs off a
    // simulator, or a simulator app's activity would be credited to the phone.
    const onPhone = Array.from(connectedApps.values()).some(
        (a) => a.platform === "ios" && !a.simulatorUdid && a.deviceInfo.deviceName === phone.name,
    );
    return onPhone ? phone.name : device;
}

/** A coordinate tap (or long press) on a USB iPhone running iOS 27+. */
export async function physicalTap(phone: PhysicalIosDevice, query: TapQuery, options: TapOptions): Promise<TapResult> {
    const fail = (reason: string, suggestion: string) =>
        ({ ...formatTapFailure({ query, error: reason, attempted: [{ strategy: "device-hid", reason }], suggestion, device: phone.name }), platform: "ios" });

    // First, so an older phone is not sent through a capture or told to use x/y.
    if (!(parseInt(phone.version, 10) >= IOS_HID_MIN_MAJOR)) {
        return fail(
            `tap on a physical iPhone needs iOS ${IOS_HID_MIN_MAJOR} or later; this device runs iOS ${phone.version}. Older iOS has no host touch injection. Use a simulator.`,
            "Use a simulator, or update the phone to iOS 27.",
        );
    }
    if (query.x === undefined || query.y === undefined) {
        return fail(
            "A physical iPhone takes coordinate taps only. Call screenshot({ device }) and pass x/y from it; testID, text and component are not supported on a phone yet.",
            "Call screenshot({ device }) and tap by x/y.",
        );
    }

    // The before-frame comes straight from the capture, not captureScreenshot,
    // which drops the error (the error is what says DDI, missing binary or hang).
    const before = await physicalIosScreenshot(phone.udid);
    if (!before.success || !before.data) {
        return fail(before.error ?? "Could not capture the phone's screen before the tap.", "Fix the capture first: screenshot({ device }) must work.");
    }
    // Measured 2026-11-14: a session on a sleeping phone exits 0, wakes it and
    // the touch lands on the lock screen, which would read as a success.
    if (await isNearUniform(before.data)) {
        return fail(
            "The phone's screen is off. A tap now wakes it and lands on the lock screen. Unlock the phone (no passcode: swipe up from the bottom edge) and retry.",
            "Unlock the phone, then retry the tap.",
        );
    }
    const frame = { width: before.originalWidth || 0, height: before.originalHeight || 0, scaleFactor: before.scaleFactor || 1 };
    const hid = toHidPoint(query.x, query.y, frame);
    if ("error" in hid) return fail(hid.error, "Take a screenshot and use coordinates from it.");

    const sent = await physicalIosTap(phone, hid, options.duration);
    if (!sent.success) return fail(sent.error, "Take a screenshot to see whether the touch landed before retrying.");

    const shouldScreenshot = options.screenshot !== false;
    const shouldVerify = options.verify !== false;
    let { screenshot, verification } = await verifyAndCapture({
        platform: "ios",
        shouldVerify,
        shouldScreenshot,
        beforeBuffer: before.data,
        udid: phone.udid,
        beforeScaleFactor: frame.scaleFactor,
        markerPx: { x: query.x, y: query.y },
    });
    // Same rule as the native branch: the frame goes back only when asked for,
    // or when nothing changed and it is the evidence.
    if (!shouldScreenshot && verification?.meaningful !== false) screenshot = undefined;

    const result = formatTapSuccess({
        method: "device-hid",
        query,
        convertedTo: { x: hid.x, y: hid.y, unit: "hid" },
        platform: "ios",
        device: phone.name,
        screenshot,
        verification,
    });
    // A coordinate tap inspects no handler, so hasLongPress stays undefined.
    const longPress = buildLongPressReport({ durationMs: options.duration });
    if (longPress) result.longPress = longPress;
    if (options.burst) {
        const note = "burst is not supported on a physical iPhone (each frame takes over a second); verified with single frames.";
        result.warning = result.warning ? `${result.warning} ${note}` : note;
    }
    return result;
}
