import { resolveEmulatorBridge } from "./emulatorBridge.js";
import { sendTouchFrames, type TouchPoint } from "./emulatorGrpc.js";
import { planPinch } from "./pinchGeometry.js";
import { FRAME_INTERVAL_MS, SETTLE_MS } from "./pinchThresholds.js";
import { androidGetScreenSize, getDefaultAndroidDevice } from "./android.js";

export interface AndroidPinchOptions {
    /** Focal point in DEVICE pixels. */
    focalX: number;
    focalY: number;
    direction: "in" | "out";
    scale: number;
    angleDeg: number;
    durationMs: number;
    serial?: string;
}

export interface AndroidPinchResult {
    success: boolean;
    result?: string;
    error?: string;
    frameCount?: number;
    gestureCount?: number;
    startHalf?: number;
    endHalf?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Lift both contacts at their last known position.
 *
 * The emulator holds a slot open until it sees pressure 0 for that
 * identifier, so an aborted gesture would leave two fingers permanently
 * down and corrupt every later gesture. This runs on the error path too.
 */
async function releasePointers(
    bridge: { port: number; token: string },
    lastFrame: TouchPoint[] | undefined
): Promise<void> {
    if (!lastFrame) return;
    await sendTouchFrames(
        bridge,
        [lastFrame.map((p) => ({ ...p, pressure: 0 }))],
        0
    );
}

export async function androidPinch(options: AndroidPinchOptions): Promise<AndroidPinchResult> {
    const serial = options.serial ?? (await getDefaultAndroidDevice());
    if (!serial) {
        return { success: false, error: "No Android device connected. Run list_devices to see what is available." };
    }

    const resolution = await resolveEmulatorBridge(serial);
    if (!resolution.ok) {
        return { success: false, error: resolution.message };
    }
    const bridge = resolution.bridge;

    const size = await androidGetScreenSize(serial);
    if (!size.success || !size.width || !size.height) {
        return {
            success: false,
            error: `Could not read the screen size for ${serial}: ${size.error ?? "no dimensions returned"}`,
        };
    }

    const plan = planPinch({
        focalX: options.focalX,
        focalY: options.focalY,
        direction: options.direction,
        scale: options.scale,
        angleDeg: options.angleDeg,
        durationMs: options.durationMs,
        screenWidth: size.width,
        screenHeight: size.height,
    });

    if (!plan.viable) {
        return { success: false, error: plan.note ?? "The requested pinch would not be recognised." };
    }

    let lastFrame: TouchPoint[] | undefined;
    for (let i = 0; i < plan.gestures.length; i++) {
        const frames = plan.gestures[i];
        lastFrame = frames[frames.length - 1];

        const sent = await sendTouchFrames(bridge, frames, FRAME_INTERVAL_MS);
        if (!sent.success) {
            await releasePointers(bridge, lastFrame);
            return { success: false, error: `Failed to send touch frames: ${sent.error}` };
        }
        // Let the recognizer end this gesture before the next contact lands.
        if (i < plan.gestures.length - 1) await sleep(SETTLE_MS);
    }

    const frameCount = plan.gestures.reduce((n, g) => n + g.length, 0);
    return {
        success: true,
        result:
            `Pinched ${options.direction} at (${Math.round(options.focalX)}, ${Math.round(options.focalY)}) ` +
            `over ${plan.gestures.length} gesture(s), ${frameCount} frames`,
        frameCount,
        gestureCount: plan.gestures.length,
        startHalf: plan.startHalf,
        endHalf: plan.endHalf,
    };
}
