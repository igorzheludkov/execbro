// The adversarial cases here are verbatim from a live Android 16 emulator on
// 2026-07-29. Each one defeats an obvious-but-wrong ownership rule.

import { describe, it, expect } from "@jest/globals";
import { isOwned } from "../../core/logOwnership.js";
import type { AppIdentity, RawLogLine } from "../../core/logEvents.js";

const APP: AppIdentity = {
    deviceKey: "emulator-5554",
    platform: "android",
    appId: "com.rndebuggertestapp",
    pid: 23325,
};

function line(over: Partial<RawLogLine>): RawLogLine {
    return {
        ts: new Date("2026-07-29T22:11:05.015Z"),
        level: "info",
        pid: 1,
        tag: "Unknown",
        message: "",
        raw: "",
        ...over,
    };
}

describe("isOwned", () => {
    it("owns a tombstone the app did not write, via its declared subject", () => {
        // Written by tombstoned (pid 22617); the dead app was 17782. Pid
        // matching can never work here, which is why `declared` is rule 1.
        const v = isOwned(line({
            pid: 22617,
            tag: "DEBUG",
            level: "fatal",
            subject: "com.rndebuggertestapp",
            message: "pid: 17782, tid: 17832 >>> com.rndebuggertestapp <<<",
        }), { ...APP, pid: undefined });
        expect(v).toEqual({ owned: true, reason: "declared" });
    });

    it("owns lines from the live pid", () => {
        expect(isOwned(line({ pid: 23325, tag: "ReactNative" }), APP))
            .toEqual({ owned: true, reason: "pid" });
    });

    it("owns an ANR reported by ActivityManager", () => {
        expect(isOwned(line({
            pid: 660,
            tag: "ActivityManager",
            level: "error",
            message: "ANR in com.rndebuggertestapp",
        }), APP)).toEqual({ owned: true, reason: "verdict" });
    });

    it("rejects MMKV lines that contain the package as a FILESYSTEM PATH", () => {
        expect(isOwned(line({
            pid: 998,
            tag: "MMKV",
            message: "<MemoryFile.cpp:103::open> open fd[138] /data/data/com.rndebuggertestapp/files/mmkv",
        }), { ...APP, pid: undefined })).toEqual({ owned: false });
    });

    it("rejects nativeloader apk paths from a foreign pid", () => {
        expect(isOwned(line({
            pid: 777,
            tag: "nativeloader",
            message: "Load /data/app/~~s-V8/com.rndebuggertestapp-Ht1RP33/base.apk!/lib/arm64-v8a/librnscreens.so: ok",
        }), { ...APP, pid: undefined })).toEqual({ owned: false });
    });

    it("rejects ActivityThread lines emitted by OTHER apps' pids", () => {
        expect(isOwned(line({
            pid: 21908,
            tag: "ActivityThread",
            message: "Package [com.rndebuggertestapp] reported as REPLACED, but missing application info.",
        }), { ...APP, pid: undefined })).toEqual({ owned: false });
    });

    it("rejects an allowlisted tag that names a DIFFERENT package", () => {
        expect(isOwned(line({
            pid: 660,
            tag: "ActivityManager",
            message: "ANR in com.google.android.apps.messaging",
        }), APP)).toEqual({ owned: false });
    });

    it("rejects a sibling package that merely EXTENDS the app id", () => {
        // Debug/release variants differing by applicationIdSuffix are normal.
        expect(isOwned(line({
            pid: 660,
            tag: "ActivityManager",
            level: "error",
            message: "ANR in com.rndebuggertestapp.debug",
        }), APP)).toEqual({ owned: false });
    });

    it("rejects a parent package when the app id is the longer one", () => {
        expect(isOwned(line({
            pid: 660,
            tag: "ActivityManager",
            level: "error",
            message: "ANR in com.rndebuggertestapp",
        }), { ...APP, appId: "com.rndebuggertestapp.debug" })).toEqual({ owned: false });
    });

    it("still owns an exact package match at end of message", () => {
        expect(isOwned(line({
            pid: 660,
            tag: "ActivityManager",
            level: "error",
            message: "ANR in com.rndebuggertestapp",
        }), APP)).toEqual({ owned: true, reason: "verdict" });
    });

    it("rejects a ReactNativeJS line from the app's own LIVE PID", () => {
        // React Native mirrors console.* into logcat under this tag. It is
        // already in the CDP console buffer, so owning it here would
        // double-report under source:"all" — the pid match alone (rule 2)
        // would otherwise happily claim it.
        expect(isOwned(line({
            pid: 23325,
            tag: "ReactNativeJS",
            message: "[TapTargetsScreen] Tapped: submit-btn",
        }), APP)).toEqual({ owned: false });
    });

    it("still owns a non-mirrored tag from that same live pid", () => {
        // Confirms the denylist targets the TAG, not the pid generally —
        // ordinary native output from the same process is unaffected.
        expect(isOwned(line({ pid: 23325, tag: "ReactNative" }), APP))
            .toEqual({ owned: true, reason: "pid" });
    });
});

// Verbatim from a live iPhone Air simulator on 2026-08-06. The app emitted 878
// lines in two minutes and NOT ONE passed ownership: iOS never populates
// identity.pid (only resolveAndroidPid exists), and `declared`/`verdict` both
// look for the bundle id in the MESSAGE, which ordinary os_log output has no
// reason to contain. The executable name is the identifier iOS actually
// carries, on every line, which is why it becomes rule 3.
describe("isOwned on iOS", () => {
    const IOS: AppIdentity = {
        deviceKey: "F93612A3-0042-4BDC-855F-8CAB1BDD76C6",
        platform: "ios",
        appId: "com.example.appa",
        processName: "AppA",
    };

    it("owns ordinary app output via the emitting process", () => {
        expect(isOwned(line({
            pid: 12736,
            process: "AppA",
            tag: "com.apple.CFNetwork:Default",
            message: "Task <B812CCCC>.<3> resuming, timeouts(10.0, 604800.0)",
        }), IOS)).toEqual({ owned: true, reason: "process" });
    });

    it("owns app output that never mentions the bundle id", () => {
        // The case that broke: 758 of 878 lines looked exactly like this.
        expect(isOwned(line({
            pid: 12736,
            process: "AppA",
            tag: "com.apple.UIKit:KeyboardSceneDelegate",
            message: "Keyboard scene delegate resigned first responder",
        }), IOS)).toEqual({ owned: true, reason: "process" });
    });

    it("owns a termination verdict written by runningboardd, not the app", () => {
        // Emitted by another process entirely, so the process rule cannot
        // claim it — this is what `verdict` is for, and on iOS it is the only
        // way a crash or OOM kill is ever attributed.
        expect(isOwned(line({
            pid: 231,
            process: "runningboardd",
            tag: "com.apple.runningboard:process",
            level: "error",
            message: "Process com.example.appa terminated: [jetsam] exceeded memory limit",
        }), IOS)).toEqual({ owned: true, reason: "verdict" });
    });

    it("rejects a runningboardd verdict about a DIFFERENT app", () => {
        expect(isOwned(line({
            pid: 231,
            process: "runningboardd",
            tag: "com.apple.runningboard:process",
            level: "error",
            message: "Process com.apple.mobilesafari terminated: [jetsam] exceeded memory limit",
        }), IOS)).toEqual({ owned: false });
    });

    it("rejects another app's own output", () => {
        // Reachable whenever the predicate is broadened — the process rule
        // must key on the app's executable, not merely on the field existing.
        expect(isOwned(line({
            pid: 95301,
            process: "locationd",
            tag: "com.apple.locationd:Position",
            message: "CL: notifyClientsWithData (Fallback)",
        }), IOS)).toEqual({ owned: false });
    });

    it("does not own by process when the executable name is unknown", () => {
        // resolveIosProcessName failed (app not installed, simctl error), so
        // the fetch was never process-scoped either. Claiming ownership on an
        // absent identifier would own the whole device.
        expect(isOwned(line({
            pid: 12736,
            process: "AppA",
            tag: "com.apple.CFNetwork:Default",
            message: "Task resuming",
        }), { ...IOS, processName: undefined })).toEqual({ owned: false });
    });
});
