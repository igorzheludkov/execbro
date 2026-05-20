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

export const SETTLE_DELAY_MS = 800;
export const BURST_FRAME_COUNT = 4;
export const BURST_FRAME_INTERVAL_MS = 150;
// Modal slide-up / sheet-present animations on iOS occasionally settle just
// after the 800 ms window — first diff reports zero change while the second
// (taken a few hundred ms later) catches the modal. We retry once when the
// first diff is exactly 0 so a single missed animation frame doesn't flip
// `meaningful` to false. Common-path taps that genuinely produce a change on
// the first capture are unaffected.
export const ZERO_DIFF_RETRY_DELAY_MS = 400;

export async function captureScreenshot(
    platform: "ios" | "android",
    udid?: string
): Promise<{
    buffer: Buffer;
    width: number;
    height: number;
    scaleFactor: number;
} | null> {
    try {
        const result = platform === "ios" ? await iosScreenshot(undefined, udid) : await androidScreenshot();
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

    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

    let after = await captureScreenshot(platform, udid);
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
            const rawStatusBar = platform === "ios" ? 177 : 142;
            const scale = beforeScaleFactor || after.scaleFactor || 1;
            const statusBarHeight = Math.round(rawStatusBar / scale);
            let diff = await compareScreenshots(beforeBuffer, after.buffer, {
                statusBarHeight
            });
            // Slide-up modal animations on Android have a longer linear-blend
            // phase than iOS — the first retry at +400ms still catches the
            // pre-animation frame on a slow emulator. Retry up to two times
            // before giving up. Each retry only fires when the prior diff was
            // exactly zero, so common-path taps that produced a change on the
            // first capture are unaffected. Bug #4-on-Android (EC1, 2026-05-20).
            const maxZeroDiffRetries = platform === "android" ? 2 : 1;
            for (let attempt = 0; attempt < maxZeroDiffRetries && diff.changedPixels === 0; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, ZERO_DIFF_RETRY_DELAY_MS));
                const retryAfter = await captureScreenshot(platform, udid);
                if (!retryAfter) break;
                const retryDiff = await compareScreenshots(beforeBuffer, retryAfter.buffer, {
                    statusBarHeight
                });
                if (retryDiff.changedPixels > 0) {
                    diff = retryDiff;
                    after = retryAfter;
                    break;
                }
            }
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
    beforeScaleFactor?: number;
    markerPx?: { x: number; y: number };
    source?: string;
}): Promise<{
    screenshot?: TapScreenshot;
    verification?: TapVerification;
    afterWithMarkerBuffer?: Buffer;
}> {
    const { platform, beforeBuffer, udid, beforeScaleFactor, markerPx } = args;
    const source = args.source ?? "tap-burst";
    const groupIntent = source === "tap-burst" ? "tap-verification" : `${source.replace(/-burst$/, "")}-verification`;
    const action: "tap" | "swipe" = source.startsWith("swipe") ? "swipe" : "tap";

    if (!beforeBuffer) return {};

    const frames: Buffer[] = [beforeBuffer];
    let capturedScaleFactor = beforeScaleFactor || 1;

    for (let i = 0; i < BURST_FRAME_COUNT; i++) {
        await new Promise((resolve) => setTimeout(resolve, BURST_FRAME_INTERVAL_MS));
        const capture = await captureScreenshot(platform, udid);
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
        explanation: buildVerificationExplanation({
            meaningful: analysis.meaningful,
            changeRate: analysis.persistentChangeRate,
            changedPixels: 0,
            totalPixels: 0,
            transientChangeDetected: analysis.transientChangeDetected,
            peakChangeRate: analysis.peakChangeRate,
            peakFrame: analysis.peakFrame,
            action
        })
    };

    const lastFrameIdx = frames.length - 1;
    return {
        screenshot,
        verification,
        afterWithMarkerBuffer: markedFrames[lastFrameIdx]
    };
}
