import { connectedApps } from "./state.js";
import { getActiveOrBootedSimulatorUdid } from "./ios.js";
import { getDefaultAndroidDevice } from "./android.js";

export function hasMetro(): boolean {
    return connectedApps.size > 0;
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
    get_network_stats: [],
    get_request_details: [],
    get_screen_layout: ["ios_describe_all", "android_describe_all"],
    get_inspector_selection: ["ios_describe_point", "android_describe_point"],
};

export type MetroMissingHintOptions = {
    toolName: string;
    devices?: NativeDeviceAvailability;
};

export function buildMetroMissingHint({ toolName, devices }: MetroMissingHintOptions): string {
    const fallbacks = NATIVE_FALLBACKS[toolName] ?? [];
    const lines: string[] = [];
    lines.push("[NO METRO] This tool reads data from the JS runtime, which requires an attached debugger.");

    if (devices?.any) {
        const platformsSeen: string[] = [];
        if (devices.ios) platformsSeen.push("iOS simulator");
        if (devices.android) platformsSeen.push("Android device");
        lines.push(`Detected ${platformsSeen.join(" + ")} but no Metro connection. Start your React Native app and run scan_metro to enable full data capture.`);
    } else {
        lines.push("No running simulators or devices detected. Boot one, start your app, then run scan_metro.");
    }

    if (fallbacks.length > 0) {
        lines.push(`Native-only alternatives you can use now: ${fallbacks.join(", ")}.`);
    }

    lines.push("For in-app console/network capture without Metro, install the SDK: npm install react-native-ai-devtools-sdk");
    return lines.join("\n");
}

// Convenience: return the hint only when Metro is truly absent. Returns "" otherwise
// so callers can concatenate unconditionally.
export async function metroMissingHintIfAbsent(toolName: string): Promise<string> {
    if (hasMetro()) return "";
    const devices = await detectNativeDevices();
    return "\n\n" + buildMetroMissingHint({ toolName, devices });
}
