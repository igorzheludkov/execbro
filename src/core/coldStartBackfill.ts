import { connectedApps, getEpoch, getLogBuffer, matchDeviceName } from "./state.js";
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

// The connect-time probe fires 200 ms after attach; a slow JS thread answers later.
const SDK_PROBE_WAIT_MS = 3000;
const SDK_PROBE_POLL_MS = 100;

const pending = new Map<string, Promise<void>>();

/**
 * The connect-time SDK probe's verdict for this device, waiting briefly for it.
 * Reads the registry only: isSDKInstalled falls back to executeInApp, whose
 * reconnect path scans Metro, which a background job must never trigger.
 * Undefined when no probe answered (proceed; the seam dedupe still applies).
 */
async function sdkPresence(deviceName: string): Promise<boolean | undefined> {
    const deadline = Date.now() + SDK_PROBE_WAIT_MS;
    for (;;) {
        const apps = [...connectedApps.values()].filter((a) => a.deviceInfo.deviceName === deviceName);
        if (apps.length === 0) return undefined;
        if (apps.some((a) => a.sdkPresent === true)) return true;
        if (apps.every((a) => a.sdkPresent === false)) return false;
        if (Date.now() >= deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, SDK_PROBE_POLL_MS));
    }
}

/** The lines of the current JS run of the current process, logged before `until`. */
export function selectBackfillLines(
    lines: RawLogLine[],
    opts: { until: Date; notBefore?: Date; platform: "ios" | "android" }
): RawLogLine[] {
    let out = lines.filter((l) => l.ts < opts.until);
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
    if (await sdkPresence(deviceName)) return;

    // No live target: Chromium, a physical iPhone (no log target), or an app
    // this device has no identity for.
    const target = (await resolveLogTargets(deviceName))
        .find((t) => t.deviceName === deviceName && t.identitySource === "live" && t.identity);
    if (!target?.identity) return;

    const notBeforeMs = previousCdpConsoleEnd(deviceName);
    const sinceTs = new Date(Math.max(attachAt.getTime() - BACKFILL_LOOKBACK_MS, notBeforeMs ?? 0));
    const notBefore = notBeforeMs === undefined ? undefined : new Date(notBeforeMs);

    const readStart = new Date();
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

    // The cut is where CDP started delivering, not the attach: a line logged
    // between the attach and Runtime.enable taking effect reached neither
    // source (seen on device, ~100 ms). CDP delivers in order, so nothing
    // before the first live line came over it; with no live line yet, nothing
    // logged before this read did either. The seam dedupe covers a line in flight.
    // ponytail: cut uses host time against the device clock; exact on a simulator, skews on a physical Android whose clock drifts
    const buffer = getLogBuffer(deviceName);
    const epoch = getEpoch(deviceName);
    const live = buffer.getAll().filter((e) => !e.origin && e.epoch === epoch && e.timestamp >= attachAt);
    const until = live.length > 0
        ? new Date(Math.min(...live.map((e) => e.timestamp.getTime())))
        : readStart;
    const selected = selectBackfillLines(lines, { until, notBefore, platform: target.platform });
    const inserted = buffer.insertBackfill(
        selected.map((l) => ({ timestamp: l.ts, level: l.level, message: l.message, origin: "systemLog" as const })),
        epoch
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
