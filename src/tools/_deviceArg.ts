import { resolveDeviceTarget, formatResolverError } from "../core/deviceResolver.js";

export type ToolErrorResponse = {
    content: [{ type: "text"; text: string }];
    isError: true;
};

function errResponse(text: string): ToolErrorResponse {
    return { content: [{ type: "text", text }], isError: true };
}

/**
 * Resolve a fuzzy user-supplied Android hint (substring of device name,
 * adb serial, emulator name) into the canonical adb serial that
 * `adb -s <serial>` accepts.
 *
 * Mirrors the resolution behaviour of `tap`, `clear_focused_input`,
 * `inspect_at_point`, etc. so platform-specific tools (`android_input_text`,
 * `android_launch_app`, `android_screenshot`, …) accept the same hints
 * cross-platform tools do. Without this layer, agents who pass `"sdk_gphone"`
 * (which works for `tap`) get a cryptic `adb: device 'sdk_gphone' not found`
 * from a sibling Android tool.
 *
 * Returns `{ ok: true, serial: undefined }` when no hint was supplied — the
 * caller's existing "use first/default device" path then takes over.
 */
export async function resolveAndroidDeviceId(
    hint?: string
): Promise<{ ok: true; serial: string | undefined } | { ok: false; response: ToolErrorResponse }> {
    if (!hint) return { ok: true, serial: undefined };
    const resolved = await resolveDeviceTarget(hint);
    if (!resolved.ok) {
        return { ok: false, response: errResponse(`Error: ${formatResolverError(resolved.error)}`) };
    }
    if (resolved.target.platform !== "android") {
        return {
            ok: false,
            response: errResponse(
                `Error: "${hint}" resolved to an iOS device (${resolved.target.deviceName}) — this tool only targets Android. Use the iOS-equivalent tool.`
            )
        };
    }
    return { ok: true, serial: resolved.target.androidSerial };
}

/**
 * Resolve a fuzzy user-supplied iOS hint (substring of simulator name,
 * UDID, or RN-registered deviceName) into the canonical simulator UDID
 * that `xcrun simctl <cmd> <udid>` accepts.
 *
 * Mirrors `resolveAndroidDeviceId` for the iOS side. Empty hint → undefined
 * so the caller's existing "use booted simulator" path takes over.
 */
export async function resolveIosUdid(
    hint?: string
): Promise<{ ok: true; udid: string | undefined } | { ok: false; response: ToolErrorResponse }> {
    if (!hint) return { ok: true, udid: undefined };
    const resolved = await resolveDeviceTarget(hint);
    if (!resolved.ok) {
        return { ok: false, response: errResponse(`Error: ${formatResolverError(resolved.error)}`) };
    }
    if (resolved.target.platform !== "ios") {
        return {
            ok: false,
            response: errResponse(
                `Error: "${hint}" resolved to an Android device (${resolved.target.deviceName}) — this tool only targets iOS. Use the Android-equivalent tool.`
            )
        };
    }
    return { ok: true, udid: resolved.target.iosUdid };
}
