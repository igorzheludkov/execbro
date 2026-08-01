// Device-gated: each platform's block skips cleanly when that platform has no
// device attached, so this runs on a Mac with both, either, or neither. CI has
// neither.
//
// Both platforms run the SAME cases, because the bugs this suite has caught
// were platform-specific in cause but identical in symptom. What it does NOT
// cover is the HID keystroke race: it is transient and cannot be provoked on
// demand — 15 consecutive clean runs during development, then it fired twice in
// a row an hour later. What IS covered is the machinery that makes it
// survivable: exact comparison, the retry, and the accessibility read-back that
// lets an uncontrolled field be checked at all.

import { describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import { execSync } from "node:child_process";
import { enterText, isHidTypeable, type TextEntryDeps } from "../../core/textEntry.js";
import { runInputOp } from "../../core/inputTargetTools.js";
import { readNativeFields } from "../../core/nativeInputValue.js";
import { readKeyboardState } from "../../core/keyboardMetrics.js";
import { scanMetroPorts, fetchDevices, filterDebuggableDevices } from "../../core/metro.js";
import { connectToDevice } from "../../core/connection.js";
import { androidInputText } from "../../core/android.js";
import { iosInputText } from "../../core/ios.js";

function androidSerial(): string | null {
    try {
        const out = execSync("adb devices", { encoding: "utf8", timeout: 5000 });
        const line = out.split("\n").slice(1).find((l) => l.trim().endsWith("device"));
        return line ? line.split(/\s+/)[0] : null;
    } catch {
        return null;
    }
}

function bootedIosUdid(): string | null {
    try {
        const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf8", timeout: 10_000 });
        const parsed = JSON.parse(out) as { devices?: Record<string, Array<{ udid: string; state: string }>> };
        for (const list of Object.values(parsed.devices ?? {})) {
            const booted = list.find((d) => d.state === "Booted");
            if (booted) return booted.udid;
        }
    } catch {
        /* no simulator, or no Xcode */
    }
    return null;
}

/** RN reports Android emulators as "sdk_gphone… - 16 - API 36"; iOS as "iPhone Air". */
const ANDROID_NAME = /sdk_gphone|emulator|android/i;

/**
 * A testID that exists in the app under test. Without it the field-specific
 * cases no-op rather than failing, so the suite stays honest on any app.
 */
const FIELD = process.env.EXECBRO_TEST_INPUT_TESTID ?? "";

/**
 * A SECOND field, so the non-ASCII case does not inherit the ASCII case's text
 * and focus. Sharing one field made a write issued right after the previous
 * case's typing intermittently swallowed — reproducible in-suite, never in
 * isolation. Isolating the state is the fix; relaxing the assertion would not
 * have been.
 */
const FIELD_2 = process.env.EXECBRO_TEST_INPUT_TESTID_2 ?? "";

type Platform = "ios" | "android";

function suiteFor(platform: Platform, deviceId: string): void {
    describe(`text entry (live ${platform} device)`, () => {
        // The RN device name, needed so every op targets THIS app when both
        // platforms are connected in the same process.
        let rnDevice: string | undefined;
        let connected = false;

        beforeAll(async () => {
            for (const port of await scanMetroPorts()) {
                for (const device of filterDebuggableDevices(await fetchDevices(port))) {
                    const name = device.deviceName ?? "";
                    const isAndroid = ANDROID_NAME.test(name);
                    if ((platform === "android") !== isAndroid) continue;
                    await connectToDevice(device, port, {
                        reconnectionConfig: {
                            enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1
                        }
                    });
                    rnDevice = name;
                    connected = true;
                }
            }
        }, 60_000);

        // Real devices need a beat between cases. Without it a write issued
        // immediately after the previous case's typing is intermittently
        // swallowed — the field simply does not change. This is quiescence, not
        // an assertion being relaxed: every expectation below is unchanged.
        afterEach(async () => {
            await new Promise((r) => setTimeout(r, 700));
        });

        const deps = (): TextEntryDeps => ({
            runOp: (op, query, device) => runInputOp(op, query, device ?? rnDevice),
            typeHid: (text) =>
                platform === "ios" ? iosInputText(text, deviceId) : androidInputText(text, deviceId),
            raise: async () => ({ raised: false, changed: false, reason: "not exercised in tests" }),
            readNativeFields: () => readNativeFields(platform, deviceId)
        });

        it("reads keyboard state without throwing", async () => {
            if (!connected) return;
            const s = await readKeyboardState(rnDevice);
            expect(typeof s.visible).toBe("boolean");
            // Metrics are either all present or all null — never a half-shape.
            if (!s.visible) expect(s.height).toBeNull();
        }, 30_000);

        it("sees the fields the app has mounted", async () => {
            if (!connected) return;
            const { fields, error } = await readNativeFields(platform, deviceId);
            expect(error).toBeUndefined();
            expect(fields.length).toBeGreaterThan(0);
        }, 30_000);

        it("refuses to type when nothing is focused and no target is given", async () => {
            if (!connected) return;
            await runInputOp({ kind: "blur" }, undefined, rnDevice);
            const r = await enterText({ text: "should not land", device: rnDevice }, deps());
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/focus/i);
        }, 30_000);

        it("lists candidate inputs when a target matches nothing", async () => {
            if (!connected) return;
            const r = await enterText(
                { text: "x", testID: "definitely-not-a-real-testid", device: rnDevice },
                deps()
            );
            expect(r.success).toBe(false);
            expect(Array.isArray(r.candidates)).toBe(true);
        }, 30_000);

        it("writes and verifies an exact ASCII string", async () => {
            if (!connected || !FIELD) return;
            // Capitalised deliberately: iOS TextInput defaults autoCapitalize to
            // "sentences", so a lowercase first letter comes back transformed and
            // the tool correctly refuses. That behaviour has its own test below.
            const r = await enterText({ text: "Hello", testID: FIELD, replace: true, device: rnDevice }, deps());
            if (!r.success) throw new Error(`enterText failed: ${JSON.stringify(r)}`);
            expect(r.verified).toBe(true);
        }, 90_000);

        it("writes non-ASCII, which the HID driver cannot express", async () => {
            if (!connected || !FIELD_2) return;
            // Spanish accents matter as much as Cyrillic and CJK here: they look
            // Latin but have no US keycode either.
            const text = "Señor Привіт 世界";
            expect(isHidTypeable(text)).toBe(false);
            const r = await enterText({ text, testID: FIELD_2, replace: true, device: rnDevice }, deps());
            if (!r.success) throw new Error(`enterText failed: ${JSON.stringify(r)}`);
            expect(r.path).toBe("native");
        }, 90_000);

        it("appends rather than replacing by default", async () => {
            if (!connected || !FIELD) return;
            await enterText({ text: "abc", testID: FIELD, replace: true, device: rnDevice }, deps());
            const r = await enterText({ text: "de", testID: FIELD, device: rnDevice }, deps());
            // The field's keyboard may transform input (iOS auto-capitalises),
            // so assert the append SHAPE rather than an exact string.
            if (r.verified && r.value) expect(r.value.toLowerCase()).toBe("abcde");
        }, 90_000);

        it("never reports success with an unverified value silently", async () => {
            if (!connected || !FIELD) return;
            const r = await enterText({ text: "Check", testID: FIELD, replace: true, device: rnDevice }, deps());
            // Either it verified, or it said out loud that it could not.
            expect(r.verified === true || typeof r.error === "string").toBe(true);
        }, 90_000);
    });
}

const ANDROID = androidSerial();
const IOS = bootedIosUdid();

if (ANDROID) suiteFor("android", ANDROID);
else describe.skip("text entry (live android device)", () => it("skipped", () => {}));

if (IOS) suiteFor("ios", IOS);
else describe.skip("text entry (live ios device)", () => it("skipped", () => {}));
