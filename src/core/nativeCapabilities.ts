/**
 * What native Android support (execbro-sdk-android, runtime "native") is, in
 * one place. Mirrors chromiumCapabilities.ts: answered once per call in
 * registerToolWithTelemetry. Adding a tool means adding its name here and
 * verifying its path against a native app.
 *
 * Design: docs/devtools-core/specs/2026-10-03-android-native-sdk-design.md
 */

export const NATIVE_TOOLS: Set<string> = new Set([
    // Session, account, meta
    "scan_metro", "connect_metro", "disconnect_metro", "ensure_connection", "get_connection_status", "get_apps",
    "get_usage_guide", "list_devices", "get_license_status", "activate_license", "delete_account", "send_feedback",
    "reset_telemetry",
    // adb only: no CDP involved
    "android_screenshot", "android_key_event", "android_long_press", "android_launch_app", "android_list_packages",
    // Routed to the SDK
    "list_debug_globals", "inspect_global", "navigate", "run_app_command",
]);

const SUPPORTED =
    "Supported on native Android apps: list_debug_globals and inspect_global (registered state), run_app_command, navigate (Jetpack Navigation), " +
    "android_screenshot, android_key_event, android_long_press, android_launch_app, android_list_packages.";

const OVERRIDES: Record<string, string> = {
    screenshot: "screenshot is not verified on native Android apps yet. Use android_screenshot instead.",
    execute_in_app:
        "execute_in_app needs a JavaScript runtime, which a native Android app does not have. Read state with inspect_global and act with run_app_command: both use what the app registered with execbro-sdk-android.",
};

export function nativeGate(toolName: string, runtime: string | undefined) {
    if (runtime !== "native" || NATIVE_TOOLS.has(toolName)) return null;
    const text = OVERRIDES[toolName] ??
        `${toolName} is not supported on native Android apps (execbro-sdk-android) yet. ${SUPPORTED} ` +
        "Until it is, drive the app with run_app_command and navigate, and look at it with android_screenshot. " +
        "To run it against a React Native app instead, pass device=<name> (get_apps lists connected targets).";
    return {
        content: [{ type: "text" as const, text }] as [{ type: "text"; text: string }],
        isError: true as const,
        _errorMessage: `${toolName} not supported on native`,
        _failureKind: "platform_mismatch" as const,
    };
}
