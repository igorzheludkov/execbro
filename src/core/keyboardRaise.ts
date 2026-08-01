import { execAsync } from "./exec.js";
import { readKeyboardState, type KeyboardState } from "./keyboardMetrics.js";

export type RaiseResult = {
    /** True when the keyboard is up — whether we raised it or it already was. */
    raised: boolean;
    /** True when this call actually toggled something. */
    changed: boolean;
    reason?: string;
};

export type RaiseDeps = {
    readState: () => Promise<KeyboardState>;
    runOsascript: (script: string) => Promise<string>;
    runAdb: (args: string[]) => Promise<string>;
    delay: (ms: number) => Promise<void>;
};

/**
 * "Toggle Software Keyboard" (Cmd+K) — NOT "Connect Hardware Keyboard".
 *
 * Verified on device 2026-08-01: this raises the keyboard immediately on an
 * already-focused field, with no blur/refocus, and — the reason to prefer it —
 * without mutating the user's persistent per-UDID ConnectHardwareKeyboard
 * preference. We leave their simulator configured as we found it.
 *
 * `activate` is required: without it the AppleScript click silently no-ops,
 * returning a valid menu-item reference while nothing happens.
 */
const IOS_TOGGLE_SOFTWARE_KEYBOARD = `tell application "Simulator" to activate
delay 0.5
tell application "System Events" to tell process "Simulator"
  click menu item "Toggle Software Keyboard" of menu 1 of menu item "Keyboard" of menu 1 of menu bar item "I/O" of menu bar 1
end tell`;

/** Time for the keyboard animation to finish before re-reading visibility. */
const SETTLE_MS = 900;

function defaultDeps(device?: string): RaiseDeps {
    return {
        readState: () => readKeyboardState(device),
        runOsascript: async (script) =>
            (await execAsync(`osascript <<'EOF'\n${script}\nEOF`, { timeout: 15_000 })).stdout,
        runAdb: async (args) => (await execAsync(`adb ${args.join(" ")}`, { timeout: 10_000 })).stdout,
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    };
}

/**
 * Best-effort raise, run AFTER the text is already in the field. Never throws
 * and never fails the caller: a keyboard we could not raise is reported, not
 * escalated. It needs Accessibility permission on iOS and steals window focus,
 * neither of which belongs on the critical path of writing text.
 */
export async function raiseKeyboard(
    platform: "ios" | "android",
    deviceId?: string,
    deps: RaiseDeps = defaultDeps(deviceId)
): Promise<RaiseResult> {
    try {
        const before = await deps.readState();
        if (before.error) return { raised: false, changed: false, reason: before.error };

        // The iOS menu item is a toggle, not a show — firing it while the
        // keyboard is up would hide it. Gate on RN's own visibility read rather
        // than the menu's mark character, which lags the click by about a second.
        if (before.visible) return { raised: true, changed: false };

        if (platform === "ios") {
            await deps.runOsascript(IOS_TOGGLE_SOFTWARE_KEYBOARD);
        } else {
            const target = deviceId ? ["-s", deviceId] : [];
            await deps.runAdb([
                ...target,
                "shell",
                "settings",
                "put",
                "secure",
                "show_ime_with_hard_keyboard",
                "1"
            ]);
        }

        await deps.delay(SETTLE_MS);

        // Activating Simulator has been observed to drop the CDP connection; a
        // failed read here means "unknown", not "failed to raise".
        const after = await deps.readState();
        if (after.error) return { raised: false, changed: true, reason: after.error };

        return after.visible
            ? { raised: true, changed: true }
            : { raised: false, changed: true, reason: "toggle ran but the keyboard did not appear" };
    } catch (e) {
        return { raised: false, changed: false, reason: e instanceof Error ? e.message : String(e) };
    }
}
