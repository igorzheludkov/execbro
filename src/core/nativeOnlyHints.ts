import { connectedApps } from "./state.js";
import { getActiveOrBootedSimulatorUdid } from "./ios.js";
import { getDefaultAndroidDevice } from "./android.js";
import { pendingReconnectionKeys, getConnectionMetadata } from "./connectionState.js";
import type { AutoConnectOutcome } from "./connection.js";

export function hasMetro(): boolean {
    return connectedApps.size > 0;
}

/** Poll gap while waiting out a reconnection. */
const METRO_WAIT_POLL_MS = 100;
/**
 * Reconnection backoff runs 500ms, 1s, 2s, 4s (connection.ts). Two seconds covers
 * the first three attempts, which is where nearly every recovery lands; waiting
 * for the fourth would cost more than re-running the tool.
 */
const METRO_WAIT_BUDGET_MS = 2000;

let lastAutoConnect: AutoConnectOutcome | null = null;

/** The outcome of the last gate auto-connect, cleared on read so it never leaks into a later hint. */
export function takeLastAutoConnect(): AutoConnectOutcome | null {
    const outcome = lastAutoConnect;
    lastAutoConnect = null;
    return outcome;
}

/** Device names, where known, for the reconnections currently in flight. */
export function reconnectingDeviceNames(): string[] {
    return pendingReconnectionKeys().map((key) => {
        const meta = getConnectionMetadata(key);
        return meta?.deviceInfo.deviceName || meta?.deviceInfo.title || key;
    });
}

/**
 * True when the JS runtime is reachable, waiting out an in-flight reconnection
 * first if there is one.
 *
 * A dropped socket empties `connectedApps` for the length of the gap, so a bare
 * `hasMetro()` check reports "no Metro" for an app that is running and about to
 * be back. It waits ONLY while a reconnection is pending. With nothing in
 * flight it runs one scan_metro style connect (8081 to 8090) instead, so a
 * first call in a fresh session finds a running app without scan_metro.
 */
export async function awaitMetro(options: {
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    connect?: () => Promise<AutoConnectOutcome>;
} = {}): Promise<boolean> {
    // An outcome belongs to this call only: never let an earlier one reach a later hint.
    lastAutoConnect = null;
    if (hasMetro()) return true;
    if (pendingReconnectionKeys().length === 0) {
        // Dynamic import keeps connection.js out of this module's static graph.
        const connect = options.connect ?? (async () => (await import("./connection.js")).autoConnectAllMetro());
        lastAutoConnect = await connect();
        return hasMetro();
    }

    const budget = options.timeoutMs ?? METRO_WAIT_BUDGET_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let waited = 0; waited < budget; waited += METRO_WAIT_POLL_MS) {
        await sleep(METRO_WAIT_POLL_MS);
        if (hasMetro()) return true;
    }
    return false;
}

export type NativeDeviceAvailability = {
    ios: boolean;
    android: boolean;
    any: boolean;
};

export async function detectNativeDevices(): Promise<NativeDeviceAvailability> {
    const [iosUdid, androidSerial] = await Promise.all([
        getActiveOrBootedSimulatorUdid().catch(() => null),
        getDefaultAndroidDevice().catch(() => null),
    ]);
    const ios = !!iosUdid;
    const android = !!androidSerial;
    return { ios, android, any: ios || android };
}

// Per-tool native fallback suggestions, keyed by tool name.
// Lists the native-only tools the user can reach for instead.
const NATIVE_FALLBACKS: Record<string, string[]> = {
    get_logs: [],
    search_logs: [],
    clear_logs: [],
    get_network_requests: [],
    search_network: [],
    get_request_details: [],
    get_screen_layout: [],
};

export type MetroMissingHintOptions = {
    toolName: string;
    devices?: NativeDeviceAvailability;
    /** Device names whose reconnection is still in flight. */
    reconnecting?: string[];
    /** What the gate's own connect attempt found, when it ran one. */
    autoConnect?: AutoConnectOutcome;
};

export function buildMetroMissingHint({ toolName, devices, reconnecting, autoConnect }: MetroMissingHintOptions): string {
    const fallbacks = NATIVE_FALLBACKS[toolName] ?? [];
    const lines: string[] = [];
    lines.push("[NO METRO] This tool reads data from the JS runtime, which requires an attached debugger.");

    if (reconnecting && reconnecting.length > 0) {
        // Telling the user to run scan_metro here is wrong advice: the connection
        // existed, dropped, and is already coming back on its own. Naming the
        // device also keeps an unrelated attached device out of the diagnosis.
        lines.push(
            `${reconnecting.join(", ")} dropped its debugger connection and is reconnecting — it did not come back within the wait budget. ` +
            `Retry this call in a moment; if it keeps failing, the app is crashing or reloading repeatedly (check get_connection_status).`
        );
    } else if (autoConnect && autoConnect.ports.length === 0) {
        lines.push("Scanned Metro ports 8081 to 8090: nothing is listening. If Metro runs on another port, call connect_metro({ port }). Otherwise start Metro and the app, then call scan_metro.");
    } else if (autoConnect) {
        const { ports, failures } = autoConnect;
        lines.push(`Found Metro on port ${ports.join(", ")}, but no app attached: ${failures.join("; ")}. Right after a launch the bundle may still be loading: ensure_connection({ waitMs: 60000 }) waits for the app. Otherwise call scan_metro.`);
    } else if (devices?.any) {
        // "Attached", not "detected": adb/simctl seeing a device says nothing
        // about whether an app on it is debuggable, and the old wording read as
        // if every listed device were part of the same failure.
        const platformsSeen: string[] = [];
        if (devices.ios) platformsSeen.push("iOS simulator");
        if (devices.android) platformsSeen.push("Android device");
        lines.push(`${platformsSeen.join(" + ")} attached, but no app on any of them has a debugger connection. Start your React Native app on the device you mean, then run scan_metro.`);
    } else {
        lines.push("No running simulators or devices detected. Boot one, start your app, then run scan_metro.");
    }

    if (fallbacks.length > 0) {
        lines.push(`Native-only alternatives you can use now: ${fallbacks.join(", ")}.`);
    }

    lines.push("For in-app console/network capture without Metro, install the SDK: npm install execbro-sdk");
    return lines.join("\n");
}

// Convenience: return the hint only when Metro is truly absent. Returns "" otherwise
// so callers can concatenate unconditionally.
export async function metroMissingHintIfAbsent(toolName: string): Promise<string> {
    const autoConnect = takeLastAutoConnect() ?? undefined;
    if (hasMetro()) return "";
    const reconnecting = reconnectingDeviceNames();
    const devices = await detectNativeDevices();
    return "\n\n" + buildMetroMissingHint({ toolName, devices, reconnecting, autoConnect });
}
