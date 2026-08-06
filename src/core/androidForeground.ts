import { execFileAsync } from "./exec.js";

/**
 * Which package currently owns the focused window.
 *
 * Gestures can hand the device to something other than the app under test — a swipe that
 * starts inside the home-gesture strip sends the app to the background, a back gesture pops
 * past the last screen, a notification shade opens. None of that fails the driver call, so
 * without this the tool reports plain success and the next action is aimed at a surface
 * that is no longer the app: the frames captured afterwards show a launcher, which reads as
 * a render bug, and coordinate taps land on whatever happens to be there.
 *
 * Returns null when the query fails, so callers can stay silent rather than raise a false
 * alarm — an unanswerable question is not evidence that anything went wrong.
 */
export async function androidForegroundPackage(deviceId?: string): Promise<string | null> {
    const deviceArgs = deviceId ? ["-s", deviceId] : [];
    try {
        const { stdout } = await execFileAsync(
            "adb",
            [...deviceArgs, "shell", "dumpsys window | grep -m2 mCurrentFocus"],
            { timeout: 5000 }
        );
        return parseForegroundPackage(stdout);
    } catch {
        return null;
    }
}

/**
 * Pull the package name out of a `mCurrentFocus` dump line.
 *
 *   mCurrentFocus=Window{9b2dd10 u0 com.example.appa/com.example.appa.MainActivity}
 *     → "com.example.appa"
 *
 * A device with no focused window reports `mCurrentFocus=null`, which is not a package and
 * must not be compared against one.
 */
export function parseForegroundPackage(dump: string): string | null {
    if (!dump) return null;
    for (const line of dump.split("\n")) {
        if (line.indexOf("mCurrentFocus") === -1) continue;
        // Package names are dotted and may be followed by "/activity" or "}".
        const m = line.match(/([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\//);
        if (m) return m[1];
    }
    return null;
}

/**
 * The warning for a gesture that moved the app out of the foreground, or null when it did
 * not (or when we could not tell).
 *
 * Phrased as an instruction rather than a note because the failure is silent and the next
 * action is the destructive one: on a physical device, blind taps at pre-gesture
 * coordinates land on a launcher and can open anything.
 */
export function foregroundLossWarning(
    expectedPackage: string | null | undefined,
    actualPackage: string | null
): string | null {
    if (!expectedPackage || !actualPackage) return null;
    if (actualPackage === expectedPackage) return null;
    return (
        `⚠️ APP LEFT THE FOREGROUND — the focused package is now "${actualPackage}", not "${expectedPackage}". ` +
        `The gesture was probably claimed by the system (the home-gesture strip at the bottom edge does this). ` +
        `Any screenshot taken now shows another app, and coordinates captured before this gesture are no longer valid — ` +
        `do NOT tap them. Bring the app back with android_launch_app, then re-read the screen.`
    );
}
