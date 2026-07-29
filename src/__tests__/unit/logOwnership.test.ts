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
});
