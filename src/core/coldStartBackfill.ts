import { getEpoch, getLogBuffer, matchDeviceName } from "./state.js";
import { isSDKInstalled } from "./sdkBridge.js";
import { resolveLogTargets } from "./nativeLogs.js";
import { fetchIosLines, resolveIosProcessName } from "./logSourceIos.js";
import { fetchAndroidLines, resolveAndroidPid } from "./logSourceAndroid.js";
import { RN_JS_MIRROR_TAG_ANDROID } from "./logOwnership.js";
import { previousCdpConsoleEnd } from "./sdkMirrorPoller.js";
import type { RawLogLine } from "./logEvents.js";

/**
 * Cold-start backfill: CDP attaches after the app has started, so everything
 * it logged before that never reached the JS buffer. React Native mirrors
 * console.* into the system log from the first line (os_log on iOS, logcat on
 * Android), so on every attach this reads that mirror for the current JS run
 * up to the attach moment and inserts it ahead of the live lines.
 *
 * Design: ~/rn-devtools/docs/devtools-core/specs/2026-11-25-cold-start-logs-without-sdk-research.md
 */

export const BACKFILL_LOOKBACK_MS = 10 * 60_000;

// RN prints this at every bundle start (AppRegistry.runApplication), so it is
// the JS-run boundary: a reload keeps the pid, and without it the previous
// run's lines would come back under the new epoch.
const RUN_START = 'Running "';

const pending = new Map<string, Promise<void>>();

/** The lines of the current JS run of the current process, before attach. */
export function selectBackfillLines(
    lines: RawLogLine[],
    opts: { attachAt: Date; notBefore?: Date; platform: "ios" | "android" }
): RawLogLine[] {
    let out = lines.filter((l) => l.ts < opts.attachAt);
    if (out.length === 0) return out;

    const pid = out.reduce((a, b) => (b.ts >= a.ts ? b : a)).pid;
    out = out.filter((l) => l.pid === pid);

    let runStart = -1;
    out.forEach((l, i) => { if (l.message.startsWith(RUN_START)) runStart = i; });
    if (runStart > 0) out = out.slice(runStart);

    if (opts.notBefore) {
        const notBefore = opts.notBefore;
        out = out.filter((l) => l.ts > notBefore);
    }

    if (opts.platform !== "android") return out;
    // logcat splits a multi-line message into one line each, with the same header.
    // ponytail: two console calls in the same ms with the same tid get joined; logcat has no message id
    const joined: RawLogLine[] = [];
    for (const l of out) {
        const prev = joined[joined.length - 1];
        if (prev && prev.pid === l.pid && prev.tid === l.tid && prev.level === l.level && prev.ts.getTime() === l.ts.getTime()) {
            joined[joined.length - 1] = { ...prev, message: `${prev.message}\n${l.message}`, raw: `${prev.raw}\n${l.raw}` };
        } else {
            joined.push(l);
        }
    }
    return joined;
}

async function runBackfill(deviceName: string, attachAt: Date): Promise<void> {
    // The SDK buffers from import time and its mirror already holds these lines.
    if (await isSDKInstalled(deviceName)) return;

    // No live target: Chromium, a physical iPhone (no log target), or an app
    // this device has no identity for.
    const target = (await resolveLogTargets(deviceName))
        .find((t) => t.deviceName === deviceName && t.identitySource === "live" && t.identity);
    if (!target?.identity) return;

    const notBeforeMs = previousCdpConsoleEnd(deviceName);
    const sinceTs = new Date(Math.max(attachAt.getTime() - BACKFILL_LOOKBACK_MS, notBeforeMs ?? 0));
    const notBefore = notBeforeMs === undefined ? undefined : new Date(notBeforeMs);

    let lines: RawLogLine[];
    if (target.platform === "android") {
        const pid = await resolveAndroidPid(target.identity.appId, target.adbSerial);
        if (!pid) return;
        lines = await fetchAndroidLines({ serial: target.adbSerial, sinceTs, pid, tags: [RN_JS_MIRROR_TAG_ANDROID] });
    } else {
        const processName = await resolveIosProcessName(target.deviceKey, target.identity.appId);
        if (!processName) return;
        lines = await fetchIosLines({ udid: target.deviceKey, processName, sinceTs, jsMirror: true });
    }

    // ponytail: cut uses host time against the device clock; exact on a simulator, skews on a physical Android whose clock drifts
    const selected = selectBackfillLines(lines, { attachAt, notBefore, platform: target.platform });
    const inserted = getLogBuffer(deviceName).insertBackfill(
        selected.map((l) => ({ timestamp: l.ts, level: l.level, message: l.message, origin: "systemLog" as const })),
        getEpoch(deviceName)
    );
    if (inserted > 0) console.error(`[execbro] Backfilled ${inserted} pre-attach log lines for ${deviceName} from the system log`);
}

/** Fire-and-forget: attach never waits on this, and a failure only logs. */
export function startColdStartBackfill(deviceName: string, attachAt: Date = new Date()): void {
    const job = runBackfill(deviceName, attachAt).catch((err) => {
        console.error(`[execbro] Cold-start log backfill failed for ${deviceName}: ${err instanceof Error ? err.message : String(err)}`);
    });
    pending.set(deviceName, job);
    void job.finally(() => {
        if (pending.get(deviceName) === job) pending.delete(deviceName);
    });
}

/** Let a read include a backfill still running, for at most maxWaitMs. */
export async function awaitColdStartBackfill(device?: string, maxWaitMs = 2000): Promise<void> {
    let jobs = [...pending.values()];
    if (device) {
        const name = matchDeviceName(device, pending.keys());
        jobs = name ? [pending.get(name)!] : [];
    }
    if (jobs.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        Promise.all(jobs),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); }),
    ]);
    clearTimeout(timer);
}
