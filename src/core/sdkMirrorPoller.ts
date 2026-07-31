import { executeInApp } from "./executor.js";
import { getLogBuffer, getNetworkBuffer, getEpoch, connectedApps } from "./state.js";
import { mapConsoleType } from "./logs.js";

export const ACTIVE_INTERVAL_MS = 3000;
export const IDLE_INTERVAL_MS = 10000;

const timers = new Map<string, NodeJS.Timeout>();
// Per device: epoch-scoped SDK ids already mirrored, so repeated polls are no-ops.
const mirrored = new Map<string, Set<string>>();

interface RawNetworkEntry {
    id: string;
    timestamp: number;
    method: string;
    url: string;
    status?: number;
    statusText?: string;
    duration?: number;
    requestHeaders?: Record<string, string>;
    requestBody?: string;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    mimeType?: string;
    error?: string;
    completed?: boolean;
}

interface RawConsoleEntry {
    id: string;
    timestamp: number;
    level: string;
    message: string;
}

function pollingDisabled(): boolean {
    return process.env.EXECBRO_DISABLE_SDK_MIRROR === "1";
}

function seenSet(device: string): Set<string> {
    let set = mirrored.get(device);
    if (!set) {
        set = new Set();
        mirrored.set(device, set);
    }
    return set;
}

/** Test-only: drop all mirror bookkeeping and timers. */
export function __resetMirrorState(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    mirrored.clear();
}

// Both SDK buffers in one round-trip. The accessor matches sdkBridge.ts so the
// poller works against every published SDK version. Guarded so a missing SDK
// yields empty arrays rather than a thrown TypeError.
const READ_EXPRESSION = `JSON.stringify((function(){
  var sdk = globalThis.__EXECBRO__ || globalThis.__RN_AI_DEVTOOLS__;
  if (!sdk) return { network: [], console: [] };
  return {
    network: typeof sdk.getNetworkEntries === "function" ? sdk.getNetworkEntries() : [],
    console: typeof sdk.getConsoleEntries === "function" ? sdk.getConsoleEntries() : []
  };
})())`;

/**
 * One mirror pass: read both SDK buffers and copy anything not already
 * mirrored for the device's current epoch into the server-side buffers.
 *
 * This exists because the server suppresses its own network capture whenever
 * the SDK is present (connection.ts) and otherwise keeps no copy at all — the
 * app's JS heap is the only store, so a hard restart destroys it.
 *
 * Idempotent: the epoch-scoped seen-set means re-reading the same entries adds
 * nothing. After an app restart the epoch changes, so the same SDK ids mirror
 * again as a distinct run rather than overwriting the previous one.
 */
export async function mirrorOnce(device: string): Promise<{ logs: number; network: number }> {
    let parsed: { network?: RawNetworkEntry[]; console?: RawConsoleEntry[] };
    try {
        const raw = await executeInApp(
            READ_EXPRESSION,
            false,
            {
                maxRetries: 0,
                autoReconnect: false,
                timeoutMs: 5000,
                originatingToolName: "_sdk_mirror",
            },
            device
        );
        if (!raw.success || !raw.result) return { logs: 0, network: 0 };
        parsed = JSON.parse(raw.result);
    } catch {
        return { logs: 0, network: 0 };
    }

    const epoch = getEpoch(device);
    const seen = seenSet(device);
    let logs = 0;
    let network = 0;

    for (const entry of parsed.network ?? []) {
        const key = `n:${epoch}:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        getNetworkBuffer(device).set(entry.id, {
            requestId: entry.id,
            timestamp: new Date(entry.timestamp),
            method: entry.method,
            url: entry.url,
            headers: entry.requestHeaders ?? {},
            postData: entry.requestBody,
            status: entry.status,
            statusText: entry.statusText,
            responseHeaders: entry.responseHeaders,
            responseBody: entry.responseBody,
            mimeType: entry.mimeType,
            timing: entry.duration != null ? { duration: entry.duration } : undefined,
            error: entry.error,
            completed: entry.completed ?? false,
            epoch,
        });
        network++;
    }

    for (const entry of parsed.console ?? []) {
        const key = `c:${epoch}:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        getLogBuffer(device).add({
            timestamp: new Date(entry.timestamp),
            level: mapConsoleType(entry.level),
            message: entry.message,
            epoch,
        });
        logs++;
    }

    return { logs, network };
}

/**
 * Pull anything the in-app SDK holds into the server buffer before a read.
 * The background poller runs every 3-10s; this closes the gap so a read never
 * shows data staler than a live SDK query would have.
 */
export async function refreshMirror(device?: string): Promise<void> {
    try {
        if (device) {
            await mirrorOnce(device);
            return;
        }
        for (const app of connectedApps.values()) {
            await mirrorOnce(app.deviceInfo.deviceName || app.deviceInfo.title || "unknown");
        }
    } catch {
        // Non-fatal — a stale read beats a failed one.
    }
}

export function isSdkMirrorPollerRunning(device: string): boolean {
    return timers.has(device);
}

export function startSdkMirrorPoller(device: string): void {
    if (pollingDisabled() || timers.has(device)) return;

    const schedule = (delay: number): void => {
        const timer = setTimeout(async () => {
            let active = false;
            try {
                const result = await mirrorOnce(device);
                active = result.logs > 0 || result.network > 0;
            } catch {
                active = false;
            }
            if (timers.has(device)) {
                schedule(active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
            }
        }, delay);
        timer.unref?.();
        timers.set(device, timer);
    };

    schedule(ACTIVE_INTERVAL_MS);
}

export function stopSdkMirrorPoller(device: string): void {
    const timer = timers.get(device);
    if (timer) clearTimeout(timer);
    timers.delete(device);
}

export function stopAllSdkMirrorPollers(): void {
    for (const device of [...timers.keys()]) {
        stopSdkMirrorPoller(device);
    }
}
