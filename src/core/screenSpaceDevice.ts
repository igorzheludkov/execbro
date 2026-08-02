/**
 * Device-side resolution of the top inset used by {@link ScreenSpaceMetrics}.
 *
 * Kept out of screenSpace.ts so the coordinate rules there stay pure and unit-testable
 * with no simctl/adb dependency.
 */

import type { ScreenSpaceMetrics } from "./screenSpace.js";
import { getIOSSafeAreaTop } from "./ios.js";
import { androidGetStatusBarHeight } from "./android.js";

/** iPhone notch/Dynamic Island default, matching ios_screenshot's own fallback. */
const IOS_DEFAULT_SAFE_AREA_TOP = 59;
/** Common Android status bar height in dp. */
const ANDROID_DEFAULT_STATUS_BAR_DP = 24;

export async function resolveScreenSpaceMetrics(opts: {
    platform: "ios" | "android";
    /** iOS simulator UDID. */
    udid?: string;
    /** Android adb serial. */
    deviceId?: string;
}): Promise<ScreenSpaceMetrics> {
    if (opts.platform === "ios") {
        const inset = await getIOSSafeAreaTop(opts.udid).catch(() => 0);
        return { platform: "ios", topInset: inset || IOS_DEFAULT_SAFE_AREA_TOP };
    }
    const sb = await androidGetStatusBarHeight(opts.deviceId).catch(() => null);
    return {
        platform: "android",
        topInset: (sb && sb.success && sb.heightDp) || ANDROID_DEFAULT_STATUS_BAR_DP
    };
}
