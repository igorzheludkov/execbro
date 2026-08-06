import { execFileAsync } from "./exec.js";

/**
 * Detects that the Metro serving a port is a DIFFERENT PROCESS than the one previously
 * attached, and remembers that the running bundle is therefore of unknown vintage.
 *
 * Why this exists. Stop Metro, edit a file, start Metro again: the app reconnects, the CDP
 * socket comes back, scan_metro reports every device connected, and taps, swipes and
 * screenshots all work. Every available signal says the session is healthy. But the edits
 * made while Metro was down were never sent to the app, and reconnecting does not reconcile
 * them — the app is still running the old bundle.
 *
 * That is worse than a plain failure. A reconnected socket reads as "you are good to go",
 * so the natural conclusion from stale behaviour is "my change is wrong", and what gets
 * reported is a fix that did not work when in truth it never loaded.
 *
 * The pid is the direct answer to "same process?", and a restart is exactly what makes HMR
 * history discontinuous. Where the pid cannot be read the module stays silent rather than
 * guessing: a false staleness warning on every call would be its own kind of noise.
 */

/** port -> pid of the process listening on it, as last observed. */
const metroPidByPort = new Map<number, string>();

/** Devices whose running bundle predates a Metro restart, with the reason to show. */
const staleBundleDevices = new Map<string, string>();

/**
 * The pid listening on a TCP port, or null when it cannot be determined.
 *
 * `lsof` is present on macOS and Linux, the platforms where the iOS Simulator and Android
 * emulators run. A missing lsof degrades to "unknown", never to a wrong answer.
 */
export async function readListenerPid(port: number): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(
            "lsof",
            ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
            { timeout: 3000 }
        );
        const pid = stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0];
        return pid || null;
    } catch {
        return null;
    }
}

/**
 * Compare the process now serving `port` against the one seen before.
 *
 * Returns true when it demonstrably changed. A first observation is not a change — there is
 * no earlier bundle to be stale relative to — and an unreadable pid is not a change either.
 */
export async function metroProcessChanged(port: number): Promise<boolean> {
    const pid = await readListenerPid(port);
    if (!pid) return false;
    const previous = metroPidByPort.get(port);
    metroPidByPort.set(port, pid);
    return previous !== undefined && previous !== pid;
}

/** Record that this device's bundle may predate the edits on disk. */
export function markBundlePossiblyStale(deviceName: string, reason: string): void {
    const key = (deviceName || "").trim();
    if (key) staleBundleDevices.set(key, reason);
}

/**
 * Clear the flag for a device — a full reload is the one action that guarantees the running
 * bundle matches what Metro can serve.
 */
export function clearBundleStale(deviceName?: string): void {
    if (!deviceName) {
        staleBundleDevices.clear();
        return;
    }
    const key = deviceName.trim();
    staleBundleDevices.delete(key);
    // Callers pass whatever name they hold — a substring of the registry's, sometimes. Clear
    // any entry that name would have matched, so a reload does not leave a phantom warning.
    for (const known of [...staleBundleDevices.keys()]) {
        if (known.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(known.toLowerCase())) {
            staleBundleDevices.delete(known);
        }
    }
}

/**
 * The warning to attach to a tool result, or null when the bundle is not suspect.
 *
 * Matching is substring-based in both directions because callers address devices by
 * whatever fragment they were given ("iPhone" for "iPhone Air"), the same rule device
 * resolution uses.
 */
export function bundleStaleWarning(deviceName?: string): string | null {
    if (staleBundleDevices.size === 0) return null;
    if (!deviceName) {
        const [first] = staleBundleDevices.values();
        return first ?? null;
    }
    const needle = deviceName.trim().toLowerCase();
    for (const [known, reason] of staleBundleDevices.entries()) {
        const k = known.toLowerCase();
        if (k.includes(needle) || needle.includes(k)) return reason;
    }
    return null;
}

/** The message itself, kept in one place so every surface says the same thing. */
export function staleBundleMessage(deviceName: string): string {
    return (
        `⚠️ STALE BUNDLE RISK on "${deviceName}": Metro was restarted (different process) since this device last attached. ` +
        `Fast Refresh history is discontinuous — any edit made while Metro was down was never sent to the app, and reconnecting ` +
        `does not reconcile it. The app may still be running the OLD code, so behaviour that contradicts your edit is not evidence ` +
        `the edit is wrong. Run reload_app to be certain, or get_refresh_status to see when the app last accepted an update.`
    );
}

/** Test seam. */
export function resetMetroIdentity(): void {
    metroPidByPort.clear();
    staleBundleDevices.clear();
}
