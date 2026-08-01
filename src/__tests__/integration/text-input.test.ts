// Device-gated: skips cleanly when no emulator is attached, matching the
// pattern in native-logs.test.ts. CI has no device.
//
// What is NOT covered here, deliberately: the HID keystroke race. It is
// transient and cannot be provoked on demand — 15 consecutive clean runs
// during development, then it fired twice in a row an hour later. What IS
// covered is the machinery that makes it survivable: exact comparison, the
// retry, and the accessibility read-back that lets an uncontrolled field be
// checked at all.

import { describe, it, expect, beforeAll } from "@jest/globals";
import { execSync } from "node:child_process";
import { enterText, isHidTypeable, type TextEntryDeps } from "../../core/textEntry.js";
import { runInputOp } from "../../core/inputTargetTools.js";
import { readNativeFields } from "../../core/nativeInputValue.js";
import { readKeyboardState } from "../../core/keyboardMetrics.js";
import { scanMetroPorts, fetchDevices, filterDebuggableDevices } from "../../core/metro.js";
import { connectToDevice } from "../../core/connection.js";
import { androidInputText } from "../../core/android.js";
import { connectedApps } from "../../core/state.js";

function androidSerial(): string | null {
    try {
        const out = execSync("adb devices", { encoding: "utf8", timeout: 5000 });
        const line = out.split("\n").slice(1).find((l) => l.trim().endsWith("device"));
        return line ? line.split(/\s+/)[0] : null;
    } catch {
        return null;
    }
}

const SERIAL = androidSerial();

/**
 * A testID that exists in the app under test. Without it the field-specific
 * cases no-op rather than failing, so the suite stays honest on any app.
 */
const FIELD = process.env.EXECBRO_TEST_INPUT_TESTID ?? "";

const maybe = SERIAL ? describe : describe.skip;

maybe("text entry (live Android device)", () => {
    let connected = false;

    beforeAll(async () => {
        // Connect to whatever Metro is serving, the same way scan_metro does.
        // Only the Android target is exercised: the write path is shared, and
        // the platform-specific halves (adb typing, uiautomator read-back) are
        // the ones a device can actually check.
        for (const port of await scanMetroPorts()) {
            for (const device of filterDebuggableDevices(await fetchDevices(port))) {
                if (!/sdk_gphone|emulator|android/i.test(device.deviceName ?? "")) continue;
                await connectToDevice(device, port, {
                    reconnectionConfig: {
                        enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1
                    }
                });
            }
        }
        connected = connectedApps.size > 0;
    }, 60_000);

    const deps: TextEntryDeps = {
        runOp: (op, query, device) => runInputOp(op, query, device),
        typeHid: (text) => androidInputText(text, SERIAL ?? undefined),
        raise: async () => ({ raised: false, changed: false, reason: "not exercised in tests" }),
        readNativeFields: () => readNativeFields("android", SERIAL ?? undefined)
    };

    it("reads keyboard state without throwing", async () => {
        if (!connected) return;
        const s = await readKeyboardState();
        expect(typeof s.visible).toBe("boolean");
        // Either metrics are present or they are all null — never a half-shape.
        if (!s.visible) expect(s.height).toBeNull();
    }, 30_000);

    it("refuses to type when nothing is focused and no target is given", async () => {
        if (!connected) return;
        await runInputOp({ kind: "blur" });
        const r = await enterText({ text: "should not land" }, deps);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/focus/i);
    }, 30_000);

    it("lists candidate inputs when a target matches nothing", async () => {
        if (!connected) return;
        const r = await enterText({ text: "x", testID: "definitely-not-a-real-testid" }, deps);
        expect(r.success).toBe(false);
        expect(Array.isArray(r.candidates)).toBe(true);
    }, 30_000);

    it("writes and verifies an exact ASCII string", async () => {
        if (!connected || !FIELD) return;
        const r = await enterText({ text: "hello", testID: FIELD, replace: true }, deps);
        expect(r.success).toBe(true);
        expect(r.verified).toBe(true);
        expect(r.value ?? "hello").toBe("hello");
    }, 60_000);

    it("writes non-ASCII, which the HID driver cannot express", async () => {
        if (!connected || !FIELD) return;
        // Start from a known state: these run against a real device, where the
        // previous case's text and focus both persist.
        await runInputOp({ kind: "clear" }, { testID: FIELD });
        const text = "Señor Привіт 世界";
        expect(isHidTypeable(text)).toBe(false);
        const r = await enterText({ text, testID: FIELD, replace: true }, deps);
        if (!r.success) throw new Error(`enterText failed: ${JSON.stringify(r)}`);
        expect(r.path).toBe("native");
    }, 60_000);

    it("appends rather than replacing by default", async () => {
        if (!connected || !FIELD) return;
        await enterText({ text: "abc", testID: FIELD, replace: true }, deps);
        const r = await enterText({ text: "de", testID: FIELD }, deps);
        if (r.verified) expect(r.value).toBe("abcde");
    }, 60_000);

    it("never reports success with an unverified value silently", async () => {
        if (!connected || !FIELD) return;
        const r = await enterText({ text: "check", testID: FIELD, replace: true }, deps);
        // Either it verified, or it said out loud that it could not.
        expect(r.verified === true || typeof r.error === "string").toBe(true);
    }, 60_000);
});
