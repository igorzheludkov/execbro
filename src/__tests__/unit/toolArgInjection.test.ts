import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { iosOpenUrl, iosLaunchApp, iosTerminateApp, iosBootSimulator } from "../../core/ios.js";
import { androidLaunchApp, androidInputText } from "../../core/android.js";

/**
 * End-to-end guard for the four parameters that were confirmed to execute
 * host commands before the argv conversion:
 *
 *   ios_open_url(url)          -> xcrun simctl openurl <udid> "<url>"
 *   ios_launch_app(bundleId)   -> xcrun simctl launch <udid> <bundleId>
 *   ios_boot_simulator(udid)   -> xcrun simctl boot <udid>
 *   android_launch_app(package)-> adb shell monkey -p <package> ...
 *
 * Each call below is EXPECTED to fail — the identifiers are nonsense and the
 * marker payload makes them more so. What is asserted is that the failure is
 * an ordinary tool failure and not a side effect on the host filesystem.
 *
 * Note on coverage: on a machine with neither Xcode nor adb these tools return
 * early, so the assertion passes without the command running. That is a weaker
 * test, not a wrong one — the host-side property is proven directly in
 * commandInjection.test.ts, which needs no device tooling.
 */

const MARKER = join(tmpdir(), "execbro-tool-injection-marker.txt");
const PAYLOAD = `$(touch ${MARKER})`;
const SEPARATOR_PAYLOAD = `; touch ${MARKER}`;

function clearMarker() {
    try { rmSync(MARKER, { force: true }); } catch { /* nothing to clear */ }
}

describe("tool arguments never reach a host shell", () => {
    // These call the real xcrun/adb paths, so they inherit whatever the local
    // device tooling costs — several seconds each when a device is attached and
    // the rest of the suite is competing for it. The default 5s timeout turns
    // that into a flake that says nothing about injection.
    jest.setTimeout(60_000);

    beforeEach(clearMarker);
    afterEach(clearMarker);

    it("ios_open_url: url with command substitution", async () => {
        await iosOpenUrl(`myapp://x${PAYLOAD}`, "booted").catch(() => undefined);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("ios_launch_app: bundle id with a statement separator", async () => {
        await iosLaunchApp(`com.example.app${SEPARATOR_PAYLOAD}`, "booted").catch(() => undefined);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("ios_terminate_app: bundle id with a statement separator", async () => {
        await iosTerminateApp(`com.example.app${SEPARATOR_PAYLOAD}`, "booted").catch(() => undefined);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("ios_boot_simulator: udid with a statement separator", async () => {
        await iosBootSimulator(`AAAA${SEPARATOR_PAYLOAD}`).catch(() => undefined);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("android_launch_app: package name with a statement separator", async () => {
        await androidLaunchApp(`com.example.app${SEPARATOR_PAYLOAD}`).catch(() => undefined);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("android_input_text: text with command substitution", async () => {
        await androidInputText(`hello ${PAYLOAD}`).catch(() => undefined);
        expect(existsSync(MARKER)).toBe(false);
    });
});
