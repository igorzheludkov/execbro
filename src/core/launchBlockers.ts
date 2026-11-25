import { execFileAsync } from "./exec.js";
import { fetchAndroidLines, resolveAndroidPid } from "./logSourceAndroid.js";
import { fetchIosLines, resolveIosProcessName } from "./logSourceIos.js";
import { androidForegroundPackage } from "./androidForeground.js";
import type { RawLogLine } from "./logEvents.js";

/**
 * Why a just-launched app is not attaching, read from the device while
 * ensure_connection waits for it.
 *
 * Without this the wait ran its full waitMs and ended in a bare "did not
 * attach in 120s", although every cause seen on 2026-11-26 was on the device
 * within seconds: an emulator whose screen had gone to sleep (the app never
 * resumes, so it never loads its bundle), and a red box "Unable to load
 * script" from an app that could not reach Metro.
 *
 * Every read is best effort: a failing or slow device read is "no blocker
 * found", never an error, so the wait behaves as it did before.
 */

export interface LaunchProbe {
    platform: "ios" | "android";
    /** Simulator UDID or adb serial. Absent for a USB iPhone: not probed. */
    id?: string;
    /** Bundle id / package name. */
    appId?: string;
    label: string;
    launchedAt: number;
}

const READ_TIMEOUT_MS = 5000;
// An activity takes a moment to come up after `am start`; judging the
// foreground earlier would name the launcher on a healthy launch.
const FOREGROUND_GRACE_MS = 5000;

// RN's own words when a dev build cannot get its bundle, verified on device:
// Android "Unable to load script." (ReactNative / ReactHost / BridgelessReact),
// iOS "No script URL provided." (com.facebook.react.log:native). The other two
// are the same failure in older RN versions.
const BUNDLE_FAILURE = /Unable to load script|No script URL provided|No bundle URL present|Could not connect to development server/;
const STATUS_URL = /NSErrorFailingURLStringKey=(https?:\/\/[^,}\s]+\/status)/;

/** `dumpsys power` + `dumpsys window` output -> what keeps the app from the foreground. */
export function androidScreenState(dump: string): "asleep" | "locked" | null {
    const wake = dump.match(/mWakefulness=(\w+)/)?.[1];
    if (wake === "Asleep" || wake === "Dozing") return "asleep";
    if (/isKeyguardShowing=true/.test(dump)) return "locked";
    return null;
}

/** RN's bundle-load failure sentence, if the app logged one; the line around it is ReactHost internals. */
export function bundleFailureIn(lines: RawLogLine[]): string | undefined {
    for (const l of lines) {
        const m = l.message.match(BUNDLE_FAILURE);
        if (m) return m[0] + ".";
    }
    return undefined;
}

/** The Metro status URLs an iOS app tried before giving up: where it looked for Metro. */
export function metroUrlsTried(lines: RawLogLine[]): string[] {
    const urls = lines.map((l) => l.message.match(STATUS_URL)?.[1]).filter((u): u is string => !!u);
    return [...new Set(urls)];
}

async function androidBlocker(p: LaunchProbe & { id: string }): Promise<string | null> {
    const adb = ["-s", p.id];
    const { stdout } = await execFileAsync(
        "adb",
        [...adb, "shell", "dumpsys power | grep mWakefulness=; dumpsys window | grep isKeyguardShowing"],
        { timeout: READ_TIMEOUT_MS }
    );
    const screen = androidScreenState(stdout);
    if (screen === "asleep") {
        return `The screen of ${p.label} is off, so the app cannot come to the foreground and load its bundle. ` +
            `Wake and unlock it (adb -s ${p.id} shell input keyevent KEYCODE_WAKEUP, then adb -s ${p.id} shell wm dismiss-keyguard) and launch the app again.`;
    }
    if (screen === "locked") {
        return `${p.label} is on its lock screen, so the app cannot come to the foreground and load its bundle. ` +
            `Unlock it (adb -s ${p.id} shell wm dismiss-keyguard) and launch the app again.`;
    }

    if (p.appId) {
        const pid = await resolveAndroidPid(p.appId, p.id, AbortSignal.timeout(READ_TIMEOUT_MS));
        const lines = await fetchAndroidLines({ serial: p.id, sinceTs: new Date(p.launchedAt), pid, minPriority: "W" });
        const failure = bundleFailureIn(lines);
        if (failure) {
            const reverse = (await execFileAsync("adb", [...adb, "reverse", "--list"], { timeout: READ_TIMEOUT_MS })
                .then((r) => r.stdout.trim(), () => "")) || "none";
            return `The app on ${p.label} failed to load its JS bundle: ${failure} It could not reach Metro. ` +
                `adb reverse on this device: ${reverse.replace(/\n/g, "; ")}. A listed reverse can still be dead: ` +
                `re-create it (adb -s ${p.id} reverse tcp:8081 tcp:<metro port>), or on an emulator point the app at 10.0.2.2:<metro port> from the dev menu, then reload.`;
        }

        if (Date.now() - p.launchedAt >= FOREGROUND_GRACE_MS) {
            const front = await androidForegroundPackage(p.id);
            if (front && front !== p.appId) {
                return `The app is not in the foreground on ${p.label} (focused: ${front}); a backgrounded app does not load its bundle. Launch it again.`;
            }
        }
    }
    return null;
}

async function iosBlocker(p: LaunchProbe & { id: string }): Promise<string | null> {
    if (!p.appId) return null;
    const processName = await resolveIosProcessName(p.id, p.appId, AbortSignal.timeout(READ_TIMEOUT_MS));
    if (!processName) return null;
    const lines = await fetchIosLines({ udid: p.id, processName, sinceTs: new Date(p.launchedAt), minMessageType: "error" });
    const failure = bundleFailureIn(lines);
    if (!failure) return null;
    const tried = metroUrlsTried(lines);
    return `The app on ${p.label} failed to load its JS bundle: ${failure}` +
        (tried.length > 0 ? ` It looked for Metro at ${tried.join(", ")}.` : "") +
        ` Check that Metro runs on the port the app expects, then launch the app again.`;
}

/** Why the launched app cannot attach, or null when nothing on the device says so. */
export async function launchBlocker(p: LaunchProbe): Promise<string | null> {
    if (!p.id) return null;
    const probe = { ...p, id: p.id };
    try {
        return p.platform === "android" ? await androidBlocker(probe) : await iosBlocker(probe);
    } catch {
        return null;
    }
}

/** A launchBlocker that asks the device at most once per interval; the first call asks at once. */
export function blockerWatch(p: LaunchProbe, intervalMs = 3000): () => Promise<string | null> {
    let last = 0;
    return async () => {
        if (Date.now() - last < intervalMs) return null;
        last = Date.now();
        return launchBlocker(p);
    };
}
