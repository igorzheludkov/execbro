import type { ResolveResult } from "../core/deviceResolver.js";
import {
    IOS_HID_MIN_MAJOR,
    physicalIosOrientation,
    physicalIosScreenshot,
    physicalIosDrag,
    physicalIosTap,
    resolvePhysicalIosDevice,
    toHidPoint,
    type PhysicalIosDevice,
} from "../core/iosPhysical.js";
import sharp from "sharp";
import { connectedApps } from "../core/state.js";
import type { ConnectedApp } from "../core/types.js";
import { verifyAndCapture } from "./verifyAction.js";
import {
    buildLongPressReport,
    computeSwipeFromDirection,
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

/** The RN app running on this phone: same name first, else the only app off a simulator. */
export function appOnPhone(phoneName: string): ConnectedApp | undefined {
    const offSim = Array.from(connectedApps.values()).filter((a) => a.platform === "ios" && !a.simulatorUdid);
    return offSim.find((a) => a.deviceInfo.deviceName === phoneName) ?? offSim[0];
}

// The last alternative is a CoreDevice identifier (what `xcrun devicectl list devices`
// prints), which has a simulator UDID's shape; the lookup below only runs when an app
// is attached off a simulator, and returns the hint unchanged when no phone has that id.
const PHYSICAL_UDID = /^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$|^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * The device hint the action outcome should use. The outcome finds the RN app
 * by name, simulator UDID or adb serial, so a phone's UDID becomes its name.
 * Anything not shaped like a phone UDID passes through without a pymobiledevice3 call.
 */
export async function outcomeHintFor(device?: string): Promise<string | undefined> {
    if (!device || !PHYSICAL_UDID.test(device)) return device;
    // No RN app off a simulator means nothing to map to: skip the USB listing the tap is about to run anyway.
    const offSimulator = Array.from(connectedApps.values()).filter((a) => a.platform === "ios" && !a.simulatorUdid);
    if (offSimulator.length === 0) return device;
    const phone = await resolvePhysicalIosDevice(device).catch(() => null);
    if (!phone) return device;
    // The outcome substring-matches names, and a phone is often just "iPhone":
    // hand over the name only when an app with exactly that name runs off a
    // simulator, or a simulator app's activity would be credited to the phone.
    const onPhone = offSimulator.some((a) => a.deviceInfo.deviceName === phone.name);
    return onPhone ? phone.name : device;
}

/**
 * A sleeping phone captures solid black, status bar included (measured
 * 2026-11-14). A lit screen always paints something somewhere, so a white page
 * or a dark-mode screen with an empty middle is not mistaken for it.
 */
async function isScreenOff(png: Buffer): Promise<boolean> {
    try {
        const { channels } = await sharp(png).stats();
        return channels.slice(0, 3).every((c) => c.stdev < 2 && c.mean < 16);
    } catch {
        return false;
    }
}

/** A coordinate tap (or long press) on a USB iPhone running iOS 27+. */
export async function physicalTap(
    phone: PhysicalIosDevice,
    query: TapQuery,
    options: TapOptions,
    /** Set when the fiber walk resolved the target: what it saw on the element. */
    fiber?: { hasLongPress?: boolean; element?: string },
): Promise<TapResult> {
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
            "testID, text and component taps on a physical iPhone need the app's debugger connection, and none is attached. Call ensure_connection, or tap by x/y from screenshot({ device }).",
            "Call ensure_connection, or tap by x/y.",
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
    if (await isScreenOff(before.data)) {
        return fail(
            "The phone's screen is off. A tap now wakes it and lands on the lock screen. Unlock the phone (no passcode: swipe up from the bottom edge) and retry.",
            "Unlock the phone, then retry the tap.",
        );
    }
    const frame = { width: before.originalWidth || 0, height: before.originalHeight || 0, scaleFactor: before.scaleFactor || 1 };
    const landscape = frame.width > frame.height;
    const orientation = landscape ? await physicalIosOrientation(phone.udid) : null;
    const hid = toHidPoint(query.x, query.y, frame, orientation);
    if ("error" in hid) {
        return fail(hid.error, landscape ? "Rotate the phone to portrait, or retry." : "Take a screenshot and use coordinates from it.");
    }

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
    // A coordinate tap inspects no handler, so hasLongPress stays undefined unless fiber resolved it.
    const longPress = buildLongPressReport({ durationMs: options.duration, hasLongPress: fiber?.hasLongPress, element: fiber?.element });
    if (longPress) result.longPress = longPress;
    if (options.burst) {
        const note = "burst is not supported on a physical iPhone (each frame takes over a second); verified with single frames.";
        result.warning = result.warning ? `${result.warning} ${note}` : note;
    }
    return result;
}

export type PhysicalSwipeResult =
    | { success: false; error: string }
    | {
        success: true;
        from: { x: number; y: number };
        to: { x: number; y: number };
        screenshot?: Awaited<ReturnType<typeof verifyAndCapture>>["screenshot"];
        verification?: Awaited<ReturnType<typeof verifyAndCapture>>["verification"];
    };

/**
 * A swipe on a USB iPhone running iOS 27+: one HID drag, sized from a capture of
 * the phone, so `direction` and explicit coordinates both speak screenshot pixels.
 * `beforeDrag` runs once the start point is known and before the finger moves:
 * the caller's scroll probe needs both.
 */
export async function physicalSwipe(
    phone: PhysicalIosDevice,
    args: {
        direction?: "up" | "down" | "left" | "right";
        distance?: number;
        startX?: number; startY?: number; endX?: number; endY?: number;
        durationMs?: number;
        verify?: boolean;
        screenshot?: boolean;
    },
    beforeDrag?: (start: { x: number; y: number }) => Promise<void>,
): Promise<PhysicalSwipeResult> {
    if (!(parseInt(phone.version, 10) >= IOS_HID_MIN_MAJOR)) {
        return { success: false, error: `swipe on a physical iPhone needs iOS ${IOS_HID_MIN_MAJOR} or later; this device runs iOS ${phone.version}. Use a simulator.` };
    }
    const before = await physicalIosScreenshot(phone.udid);
    if (!before.success || !before.data) return { success: false, error: before.error ?? "Could not capture the phone's screen before the swipe." };
    if (await isScreenOff(before.data)) {
        return { success: false, error: "The phone's screen is off. A swipe now wakes it and lands on the lock screen. Unlock the phone and retry." };
    }
    const frame = { width: before.originalWidth || 0, height: before.originalHeight || 0, scaleFactor: before.scaleFactor || 1 };
    const explicit = [args.startX, args.startY, args.endX, args.endY].every((v) => v !== undefined);
    const g = explicit
        ? { startX: args.startX!, startY: args.startY!, endX: args.endX!, endY: args.endY! }
        : computeSwipeFromDirection(args.direction ?? "up", args.distance, frame.width / frame.scaleFactor, frame.height / frame.scaleFactor);
    const orientation = frame.width > frame.height ? await physicalIosOrientation(phone.udid) : null;
    const from = toHidPoint(g.startX, g.startY, frame, orientation);
    const to = toHidPoint(g.endX, g.endY, frame, orientation);
    if ("error" in from) return { success: false, error: from.error };
    if ("error" in to) return { success: false, error: to.error };

    await beforeDrag?.({ x: g.startX, y: g.startY });
    const sent = await physicalIosDrag(phone, from, to, args.durationMs ?? 300);
    if (!sent.success) return { success: false, error: sent.error };

    const { screenshot, verification } = await verifyAndCapture({
        platform: "ios",
        shouldVerify: args.verify !== false,
        shouldScreenshot: args.screenshot !== false,
        beforeBuffer: before.data,
        udid: phone.udid,
        beforeScaleFactor: frame.scaleFactor,
        source: "swipe-verify",
    });
    return { success: true, from: { x: g.startX, y: g.startY }, to: { x: g.endX, y: g.endY }, screenshot, verification };
}
