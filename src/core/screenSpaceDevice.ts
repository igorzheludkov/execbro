/**
 * Device-side resolution of the top inset used by {@link ScreenSpaceMetrics}.
 *
 * Kept out of screenSpace.ts so the coordinate rules there stay pure and unit-testable
 * with no simctl/adb dependency.
 */

import type { ScreenSpaceMetrics } from "./screenSpace.js";
import { computeDeliveredDownscale } from "./screenSpace.js";
import { getIOSSafeAreaTop, getDevicePixelRatio, getIOSScreenPixelSize } from "./ios.js";
import {
    androidGetStatusBarHeight,
    androidGetDensity,
    androidGetScreenSize
} from "./android.js";

/** iPhone notch/Dynamic Island default, matching ios_screenshot's own fallback. */
const IOS_DEFAULT_SAFE_AREA_TOP = 59;
/** Common Android status bar height in dp. */
const ANDROID_DEFAULT_STATUS_BAR_DP = 24;

/**
 * points/dp -> delivered-screenshot pixels for a device whose scale and pixel size are
 * known.
 *
 * Returns **undefined** when either input is missing, which callers treat as a factor of 1
 * — i.e. coordinates stay in point space. That is strictly better than guessing, since a
 * wrong scale silently moves every coordinate. It is deliberately distinct from a resolved
 * scale that happens to equal 1: the tools surface "unknown" to the caller, because
 * point-space output handed to tap() (which speaks pixels) is exactly the mismatch this
 * whole normalisation exists to remove, and failing silently would recreate it.
 */
function pixelScaleFrom(
    deviceScale: number | null,
    pixelSize: { width: number; height: number } | null
): number | undefined {
    if (!deviceScale || deviceScale <= 0 || !pixelSize) return undefined;
    return deviceScale / computeDeliveredDownscale(pixelSize.width, pixelSize.height);
}

export async function resolveScreenSpaceMetrics(opts: {
    platform: "ios" | "android";
    /** iOS simulator UDID. */
    udid?: string;
    /** Android adb serial. */
    deviceId?: string;
}): Promise<ScreenSpaceMetrics> {
    if (opts.platform === "ios") {
        // Independent probes, and both are cached — running them concurrently keeps the
        // cold-start cost of a layout call at one round trip rather than two.
        const [inset, dpr, pixelSize] = await Promise.all([
            getIOSSafeAreaTop(opts.udid).catch(() => 0),
            getDevicePixelRatio(opts.udid).catch(() => null),
            getIOSScreenPixelSize(opts.udid).catch(() => null)
        ]);
        return {
            platform: "ios",
            topInset: inset || IOS_DEFAULT_SAFE_AREA_TOP,
            pixelScale: pixelScaleFrom(dpr, pixelSize)
        };
    }
    const [sb, density, size] = await Promise.all([
        androidGetStatusBarHeight(opts.deviceId).catch(() => null),
        androidGetDensity(opts.deviceId).catch(() => null),
        androidGetScreenSize(opts.deviceId).catch(() => null)
    ]);
    // `wm size` already reports device pixels, so no dp->px step is needed before the
    // downscale check — only the dp->px scale itself comes from the density.
    const densityScale = density && density.success && density.density
        ? density.density / 160
        : null;
    const pixelSize = size && size.success && size.width && size.height
        ? { width: size.width, height: size.height }
        : null;
    return {
        platform: "android",
        topInset: (sb && sb.success && sb.heightDp) || ANDROID_DEFAULT_STATUS_BAR_DP,
        pixelScale: pixelScaleFrom(densityScale, pixelSize)
    };
}
