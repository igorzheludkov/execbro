/**
 * What desktop (Electron / Chromium) support is, in one readable place.
 *
 * The 66 `platform ===` branches downstream all answer one question, "may this
 * tool run on this platform". It is answered once, at registration, by
 * registerToolWithTelemetry. Adding chromium support for a tool means adding
 * its name here and writing its CDP path. The mobile branches are never edited
 * and never reached.
 *
 * Design: docs/devtools-core/specs/2026-09-19-chromium-platform-support-design.md
 */

export const CHROMIUM_TOOLS: Set<string> = new Set([
    // Session, account, meta: act on no app, or list targets
    "scan_metro", "connect_metro", "disconnect_metro", "ensure_connection",
    "get_connection_status", "get_apps", "get_usage_guide", "list_devices",
    "get_license_status", "activate_license", "delete_account",
    "send_feedback", "reset_telemetry", "get_images",
    // Logs
    "get_logs", "search_logs", "clear_logs", "get_log_details",
    // Network: capture and replay. network_mock / network_condition join after device verification.
    "get_network_requests", "search_network", "get_request_details", "clear_network", "network_replay",
    // Credentials and requests
    "list_secrets", "http_request", "app_request",
    // JS state
    "execute_in_app", "list_debug_globals", "inspect_global", "redux_get_state", "redux_dispatch",
    // Component inspection via the fiber tree (DOM fallback). The surface argent rejects.
    "get_component_tree", "find_components", "inspect_component",
    // Screen and input via CDP (Page / Input domains)
    "screenshot",
]);

const OVERRIDES: Record<string, string> = {
    navigate:
        "navigate drives React Navigation and Expo Router only, which a chromium target does not have. " +
        "Use execute_in_app to move the page instead, e.g. `location.hash = '#/settings'` or your router's own API.",
    ios_screenshot:
        "ios_screenshot captures the iOS simulator, not a chromium window. Use screenshot({ device }) instead: it captures any target, chromium included.",
    android_screenshot:
        "android_screenshot captures an Android device, not a chromium window. Use screenshot({ device }) instead: it captures any target, chromium included.",
};

export function chromiumGate(toolName: string, platform: string | undefined) {
    if (platform !== "chromium" || CHROMIUM_TOOLS.has(toolName)) return null;
    const text = OVERRIDES[toolName] ??
        `${toolName} is not supported on chromium targets (Electron / Chrome) yet. ` +
        "Supported there: logs, network capture and replay, execute_in_app, debug globals, redux, http_request/app_request, component inspection (get_component_tree, find_components, inspect_component). " +
        "To run it against a React Native app instead, pass device=<name> (get_apps lists connected targets).";
    return {
        content: [{ type: "text" as const, text }] as [{ type: "text"; text: string }],
        isError: true as const,
        _errorMessage: `${toolName} not supported on chromium`,
        _failureKind: "platform_mismatch" as const,
    };
}
