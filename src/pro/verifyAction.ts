import { imageBuffer } from "../core/state.js";
import { iosScreenshot } from "../core/ios.js";
import { androidScreenshot } from "../core/android.js";
import { compareScreenshots } from "./screenshot-diff.js";
import {
    type TapScreenshot,
    type TapVerification,
    analyzeBurstFrames,
    buildVerificationExplanation,
} from "./tap.js";

export const BURST_FRAME_COUNT = 4;
export const BURST_FRAME_INTERVAL_MS = 150;

// --- Adaptive settle (replaces the old fixed 800ms sleep + zero-diff retries) ---
//
// Measured on device (iPhone Air sim, 2026-07-31): a tab switch is fully stable
// at t+239ms while a heavier transition needed t+1557ms. A single constant is
// therefore both too slow for the common case and too short for the slow one —
// which is exactly why the zero-diff retry existed. We now poll instead: capture
// frames until two consecutive ones are identical, then diff against `before`.
//
// Short lead-in before the first frame — under this, the capture reliably races
// the very start of the touch-down animation and every screen looks "changing".
export const SETTLE_POLL_START_MS = 150;
// Hard cap on the whole settle loop for a screen that never stops moving
// (spinners, video, looping animations). We return the last frame we have.
export const SETTLE_STABLE_TIMEOUT_MS = 1600;
// "Nothing happened" is the expensive conclusion to get wrong (it flips
// `meaningful` to false and sends the agent down a diagnostic path), so an idle
// screen keeps being watched until this much time has passed — long enough to
// catch a modal that only starts animating after the first frames. The old code
// sampled twice (t+800ms, t+1200ms on iOS; up to t+2000ms on Android); we sample
// continuously instead, so a shorter window still covers strictly more moments.
export const NO_CHANGE_CONFIRM_MS = 1100;
// Emulators animate slower than the iOS simulator — the Android zero-diff retry
// budget was double the iOS one for exactly this reason.
export const NO_CHANGE_CONFIRM_ANDROID_MS = 1500;
// Gap between captures while waiting out the no-change confirmation window. A
// capture already costs ~220ms, which is the real sampling interval; this just
// keeps us from hammering simctl/adb back-to-back.
export const SETTLE_IDLE_POLL_MS = 60;

export interface SettleFrame {
    buffer: Buffer;
    width: number;
    height: number;
    scaleFactor: number;
}

interface SettleDiff {
    changed: boolean;
    changeRate: number;
    changedPixels: number;
    totalPixels: number;
}

export interface SettleResult {
    frame: SettleFrame;
    diff: SettleDiff;
    /** false when the cap was hit while the screen was still moving */
    settled: boolean;
    captures: number;
}

/**
 * Wait for the screen to stop changing, then diff the settled frame against
 * `before`. Returns null only when no frame could be captured at all.
 *
 * capture/compare/now/sleep are injected so the loop is unit-testable without a
 * device; production callers use the module defaults.
 */
export async function settleAndDiff(args: {
    beforeBuffer: Buffer;
    statusBarHeight: number;
    capture: () => Promise<SettleFrame | null>;
    compare?: (a: Buffer, b: Buffer, o: { statusBarHeight: number }) => Promise<SettleDiff>;
    noChangeConfirmMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<SettleResult | null> {
    const noChangeConfirmMs = args.noChangeConfirmMs ?? NO_CHANGE_CONFIRM_MS;
    const compare = args.compare ?? compareScreenshots;
    const now = args.now ?? (() => Date.now());
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const opts = { statusBarHeight: args.statusBarHeight };

    const start = now();
    await sleep(SETTLE_POLL_START_MS);

    let prev = await args.capture();
    if (!prev) return null;
    let captures = 1;
    let diff = await compare(args.beforeBuffer, prev.buffer, opts);

    while (now() - start < SETTLE_STABLE_TIMEOUT_MS) {
        const next = await args.capture();
        // A dropped capture mid-loop isn't fatal — report what we already have.
        if (!next) return { frame: prev, diff, settled: true, captures };
        captures++;

        const stable = (await compare(prev.buffer, next.buffer, opts)).changedPixels === 0;
        prev = next;
        diff = await compare(args.beforeBuffer, next.buffer, opts);

        if (stable) {
            // Changed and stable: the common success path — return immediately.
            if (diff.changedPixels > 0) return { frame: prev, diff, settled: true, captures };
            // Still identical to `before`: keep watching until the window closes
            // so a late-starting animation isn't reported as "no change".
            if (now() - start >= noChangeConfirmMs) {
                return { frame: prev, diff, settled: true, captures };
            }
            await sleep(SETTLE_IDLE_POLL_MS);
        }
    }

    return { frame: prev, diff, settled: false, captures };
}

export async function captureScreenshot(
    platform: "ios" | "android",
    udid?: string,
    deviceId?: string
): Promise<{
    buffer: Buffer;
    width: number;
    height: number;
    scaleFactor: number;
} | null> {
    try {
        // `udid` addresses an iOS simulator, `deviceId` an adb serial. Passing
        // neither means "whichever device adb/simctl picks", which on a
        // multi-device setup is a coin flip — and a before/after diff taken
        // from the wrong screen reports a confident false "no visual change".
        const result = platform === "ios" ? await iosScreenshot(undefined, udid) : await androidScreenshot(undefined, deviceId);
        if (!result.success || !result.data) return null;
        return {
            buffer: result.data,
            width: result.originalWidth || 0,
            height: result.originalHeight || 0,
            scaleFactor: result.scaleFactor || 1
        };
    } catch {
        return null;
    }
}

function screenshotToBase64(buffer: Buffer): string {
    return buffer.toString("base64");
}

/**
 * Composite a red crosshair marker onto a screenshot at the given pixel coordinates.
 * Uses sharp + SVG so we don't need to inject into the app. Coordinates are in the
 * screenshot's own pixel space (i.e. the space the returned image uses).
 */
export async function drawTapMarker(input: Buffer, x: number, y: number): Promise<Buffer> {
    try {
        const sharp = (await import("sharp")).default;
        const size = 72;
        const half = size / 2;
        const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${half}" cy="${half}" r="${half - 8}" fill="none" stroke="white" stroke-width="6" opacity="0.85"/>
  <circle cx="${half}" cy="${half}" r="${half - 8}" fill="none" stroke="#FF2D55" stroke-width="3" opacity="1"/>
  <line x1="${half}" y1="8" x2="${half}" y2="${size - 8}" stroke="white" stroke-width="6" opacity="0.85"/>
  <line x1="8" y1="${half}" x2="${size - 8}" y2="${half}" stroke="white" stroke-width="6" opacity="0.85"/>
  <line x1="${half}" y1="8" x2="${half}" y2="${size - 8}" stroke="#FF2D55" stroke-width="2.5"/>
  <line x1="8" y1="${half}" x2="${size - 8}" y2="${half}" stroke="#FF2D55" stroke-width="2.5"/>
  <circle cx="${half}" cy="${half}" r="3" fill="#FF2D55"/>
</svg>`;
        const left = Math.round(x - half);
        const top = Math.round(y - half);
        return await sharp(input)
            .composite([{ input: Buffer.from(svg), left, top }])
            .toBuffer();
    } catch {
        return input;
    }
}

export async function verifyAndCapture(args: {
    platform: "ios" | "android";
    shouldVerify: boolean;
    shouldScreenshot: boolean;
    beforeBuffer: Buffer | null;
    udid?: string;
    deviceId?: string;
    beforeScaleFactor?: number;
    markerPx?: { x: number; y: number };
    source?: string;
}): Promise<{
    screenshot?: TapScreenshot;
    verification?: TapVerification;
    afterWithMarkerBuffer?: Buffer;
}> {
    const {
        platform,
        shouldVerify,
        shouldScreenshot,
        beforeBuffer,
        udid,
        deviceId,
        beforeScaleFactor,
        markerPx,
    } = args;
    const source = args.source ?? "tap-verify";
    const action: "tap" | "swipe" = source.startsWith("swipe") ? "swipe" : "tap";

    if (!shouldVerify && !shouldScreenshot) {
        return {
            verification: {
                skipped: true,
                skippedReason: "screenshot=false, verify=false",
                explanation: "Verification skipped (screenshot=false and verify=false)."
            }
        };
    }

    // The settle loop needs a `before` to diff against; without one (or with
    // verification disabled) there's nothing to wait for beyond the animation
    // lead-in, so take a single frame after a short pause.
    const canSettleLoop = shouldVerify && !!beforeBuffer;
    const rawStatusBar = platform === "ios" ? 177 : 142;
    const settleStatusBarHeight = Math.round(rawStatusBar / (beforeScaleFactor || 1));

    let settle: SettleResult | null = null;
    if (canSettleLoop) {
        settle = await settleAndDiff({
            beforeBuffer: beforeBuffer!,
            statusBarHeight: settleStatusBarHeight,
            capture: () => captureScreenshot(platform, udid, deviceId),
            noChangeConfirmMs: platform === "android" ? NO_CHANGE_CONFIRM_ANDROID_MS : NO_CHANGE_CONFIRM_MS
        });
    } else {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_START_MS));
    }

    let after = settle ? settle.frame : await captureScreenshot(platform, udid, deviceId);
    if (!after) {
        if (shouldVerify) {
            return {
                verification: {
                    skipped: true,
                    skippedReason: "after-screenshot capture failed",
                    explanation: "Verification skipped — could not capture post-tap screenshot."
                }
            };
        }
        return {};
    }

    let verification: TapVerification | undefined;
    if (!shouldVerify) {
        verification = {
            skipped: true,
            skippedReason: "verify=false",
            explanation: "Verification skipped (verify=false)."
        };
    } else if (!beforeBuffer) {
        verification = {
            skipped: true,
            skippedReason: "before-screenshot unavailable",
            explanation: "Verification skipped — could not capture pre-tap screenshot."
        };
    } else {
        try {
            // The settle loop already diffed the frame it returned. Only recompute
            // when it didn't run (e.g. a caller that passed a before-buffer but got
            // no settle result), so the common path pays one diff, not two.
            const diff = settle?.diff ?? await compareScreenshots(beforeBuffer, after.buffer, {
                statusBarHeight: Math.round(
                    (platform === "ios" ? 177 : 142) / (beforeScaleFactor || after.scaleFactor || 1)
                )
            });
            verification = {
                meaningful: diff.changed,
                changeRate: diff.changeRate,
                changedPixels: diff.changedPixels,
                totalPixels: diff.totalPixels,
                explanation: buildVerificationExplanation({
                    meaningful: diff.changed,
                    changeRate: diff.changeRate,
                    changedPixels: diff.changedPixels,
                    totalPixels: diff.totalPixels,
                    action
                })
            };
        } catch (err) {
            verification = {
                skipped: true,
                skippedReason: `diff failed: ${err instanceof Error ? err.message : String(err)}`,
                explanation: "Verification skipped — pixel diff threw."
            };
        }
    }

    const afterWithMarker = markerPx
        ? await drawTapMarker(after.buffer, markerPx.x, markerPx.y)
        : after.buffer;

    const screenshot: TapScreenshot = {
        image: screenshotToBase64(afterWithMarker),
        width: after.width,
        height: after.height,
        scaleFactor: after.scaleFactor
    };

    const verifyGroupId = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (beforeBuffer) {
        imageBuffer.add({
            id: `${verifyGroupId}-before`,
            image: beforeBuffer,
            timestamp: Date.now(),
            source,
            groupId: verifyGroupId,
            metadata: { phase: "before" }
        });
    }
    imageBuffer.add({
        id: `${verifyGroupId}-after`,
        image: afterWithMarker,
        timestamp: Date.now(),
        source,
        groupId: verifyGroupId,
        metadata: { phase: "after", changeRate: verification?.changeRate }
    });

    return { screenshot, verification, afterWithMarkerBuffer: afterWithMarker };
}

export async function burstCaptureAndVerify(args: {
    platform: "ios" | "android";
    beforeBuffer: Buffer | null;
    udid?: string;
    deviceId?: string;
    beforeScaleFactor?: number;
    markerPx?: { x: number; y: number };
    source?: string;
}): Promise<{
    screenshot?: TapScreenshot;
    verification?: TapVerification;
    afterWithMarkerBuffer?: Buffer;
}> {
    const { platform, beforeBuffer, udid, deviceId, beforeScaleFactor, markerPx } = args;
    const source = args.source ?? "tap-burst";
    const groupIntent = source === "tap-burst" ? "tap-verification" : `${source.replace(/-burst$/, "")}-verification`;
    const action: "tap" | "swipe" = source.startsWith("swipe") ? "swipe" : "tap";

    if (!beforeBuffer) return {};

    const frames: Buffer[] = [beforeBuffer];
    let capturedScaleFactor = beforeScaleFactor || 1;

    for (let i = 0; i < BURST_FRAME_COUNT; i++) {
        await new Promise((resolve) => setTimeout(resolve, BURST_FRAME_INTERVAL_MS));
        const capture = await captureScreenshot(platform, udid, deviceId);
        if (capture) {
            frames.push(capture.buffer);
            if (i === 0) capturedScaleFactor = capture.scaleFactor || capturedScaleFactor;
        }
    }

    if (frames.length < 2) return {};

    const rawStatusBar = platform === "ios" ? 177 : 142;
    const statusBarHeight = Math.round(rawStatusBar / capturedScaleFactor);
    const analysis = await analyzeBurstFrames(frames, { statusBarHeight });

    const markedFrames: Buffer[] = [];
    for (let i = 0; i < frames.length; i++) {
        if (markerPx && i > 0) {
            markedFrames.push(await drawTapMarker(frames[i], markerPx.x, markerPx.y));
        } else {
            markedFrames.push(frames[i]);
        }
    }

    const groupId = `burst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < markedFrames.length; i++) {
        imageBuffer.add({
            id: `${groupId}-f${i}`,
            image: markedFrames[i],
            timestamp: Date.now(),
            source,
            groupId,
            metadata: {
                frameIndex: i,
                isBefore: i === 0,
                changeRate: i === 0 ? 0 : analysis.framesWithChange.includes(i) ? analysis.peakChangeRate : 0
            }
        });
    }

    imageBuffer.addGroup({
        groupId,
        intent: groupIntent,
        source,
        timestamp: Date.now(),
        frameCount: frames.length,
        summary: {
            peakChangeRate: analysis.peakChangeRate,
            peakFrame: analysis.peakFrame,
            framesWithChange: analysis.framesWithChange,
            transientChangeDetected: analysis.transientChangeDetected,
            persistentChangeRate: analysis.persistentChangeRate
        }
    });

    const sharp = (await import("sharp")).default;
    const meta = await sharp(markedFrames[markedFrames.length - 1]).metadata();
    const screenshot: TapScreenshot = {
        image: screenshotToBase64(markedFrames[markedFrames.length - 1]),
        width: meta.width || 0,
        height: meta.height || 0,
        scaleFactor: 1
    };

    const verification: TapVerification = {
        meaningful: analysis.meaningful,
        changeRate: analysis.persistentChangeRate,
        changedPixels: 0,
        totalPixels: 0,
        transientChangeDetected: analysis.transientChangeDetected,
        peakChangeRate: analysis.peakChangeRate,
        peakFrame: analysis.peakFrame,
        burstGroupId: groupId,
        kind: analysis.kind,
        explanation: buildVerificationExplanation({
            meaningful: analysis.meaningful,
            changeRate: analysis.persistentChangeRate,
            changedPixels: 0,
            totalPixels: 0,
            transientChangeDetected: analysis.transientChangeDetected,
            peakChangeRate: analysis.peakChangeRate,
            peakFrame: analysis.peakFrame,
            action,
            kind: analysis.kind
        })
    };

    const lastFrameIdx = frames.length - 1;
    return {
        screenshot,
        verification,
        afterWithMarkerBuffer: markedFrames[lastFrameIdx]
    };
}
