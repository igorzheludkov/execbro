import { execFileAsync } from "./exec.js";

/**
 * Extra clearance added to each system bar's reported height — see the note in
 * androidSystemBarInsets for the measurement behind it.
 */
export const SYSTEM_GESTURE_MARGIN_PX = 64;

export interface SystemBarInsets {
    /** Height in device pixels of the status bar window at the top. */
    top: number;
    /** Height in device pixels of the navigation bar window at the bottom. */
    bottom: number;
}

/**
 * Read the status bar and navigation bar heights from the window manager.
 *
 * These matter for multi-touch because the system bars are separate WINDOWS,
 * not gesture zones: a contact that goes down inside them is delivered to
 * SystemUI and the app never sees it. Measured on a Pixel 9 emulator, a pinch
 * whose first contact landed at y=4 pulled the notification shade down instead
 * of reaching the app.
 *
 * Unlike the left/right back-gesture strips — which ignore a second pointer and
 * so never steal a pinch — this cannot be worked around, so the geometry has to
 * stay clear of it.
 *
 * Returns null when the query fails, so callers can fall back to defaults
 * rather than placing contacts blind.
 */
export async function androidSystemBarInsets(
    deviceId?: string
): Promise<SystemBarInsets | null> {
    const deviceArgs = deviceId ? ["-s", deviceId] : [];
    try {
        const { stdout } = await execFileAsync(
            "adb",
            [...deviceArgs, "shell", "dumpsys window | grep -E 'InsetsSource.*(statusBars|navigationBars)'"],
            { timeout: 10000 }
        );

        // statusBars   frame=[0,0][1080,142]      -> top bar is 142px tall
        // navigationBars frame=[0,2298][1080,2424] -> bottom bar is 126px tall
        const status = stdout.match(/statusBars\s+frame=\[\d+,(\d+)\]\[\d+,(\d+)\]/);
        const nav = stdout.match(/navigationBars\s+frame=\[\d+,(\d+)\]\[\d+,(\d+)\]/);

        const top = status ? parseInt(status[2], 10) - parseInt(status[1], 10) : 0;
        const bottom = nav ? parseInt(nav[2], 10) - parseInt(nav[1], 10) : 0;

        if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
        if (top === 0 && bottom === 0) return null;

        // The touchable region is LARGER than the visible bar. Measured on a
        // Pixel 9 emulator: the status bar frame is 142px, but a contact going
        // down at y=170 still pulled the notification shade while y=176 reached
        // the app — 34px beyond the reported frame. 64px doubles that margin.
        //
        // Erring large only costs a little pinch span; erring small loses the
        // gesture to SystemUI entirely, so the asymmetry favours generosity.
        // The same margin is applied at the bottom, where a symmetric gesture
        // made the nav bar impossible to measure independently.
        return { top: top + SYSTEM_GESTURE_MARGIN_PX, bottom: bottom + SYSTEM_GESTURE_MARGIN_PX };
    } catch {
        return null;
    }
}
