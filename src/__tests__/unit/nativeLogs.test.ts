import { describe, it, expect, beforeEach } from "@jest/globals";
import { runNativePipeline } from "../../core/nativeLogs.js";
import { __resetNativeLogBuffers } from "../../core/logEvents.js";
import type { AppIdentity, RawLogLine } from "../../core/logEvents.js";

const APP: AppIdentity = {
    deviceKey: "emulator-5554",
    platform: "android",
    appId: "com.rndebuggertestapp",
    pid: 23325,
};

let clock = 0;
function line(over: Partial<RawLogLine>): RawLogLine {
    clock += 1;
    return {
        ts: new Date(Date.UTC(2026, 6, 29, 22, 11, 5, clock)),
        level: "info", pid: 23325, tid: 23325, tag: "X", message: "", raw: "x",
        ...over,
    };
}

describe("runNativePipeline", () => {
    beforeEach(() => __resetNativeLogBuffers());

    it("drops foreign lines, noise, and keeps the crash", () => {
        const lines = [
            line({ pid: 998, tag: "MMKV", message: "open /data/data/com.rndebuggertestapp/files/mmkv" }),
            line({ pid: 23325, tag: "nativeloader", level: "debug", message: "Load librnscreens.so: ok" }),
            line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", subject: "com.rndebuggertestapp", message: "Cmdline: com.rndebuggertestapp" }),
            line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", message: "signal 6 (SIGABRT), code -1" }),
        ];
        const { events } = runNativePipeline(lines, APP, "Pixel", { minLevel: "warn" });
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe("crash");
        expect(events[0].id).toMatch(/^n\d+$/);
    });

    it("is idempotent across an inclusive refetch", () => {
        const lines = [
            line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", subject: "com.rndebuggertestapp", message: "Cmdline: com.rndebuggertestapp" }),
        ];
        expect(runNativePipeline(lines, APP, "Pixel", { minLevel: "warn" }).events).toHaveLength(1);
        expect(runNativePipeline(lines, APP, "Pixel", { minLevel: "warn" }).events).toHaveLength(0);
    });

    it("keeps two devices sharing one appId separate", () => {
        const other: AppIdentity = { ...APP, deviceKey: "emulator-5556" };
        const mk = () => [line({ pid: 22617, tid: 22617, tag: "DEBUG", level: "fatal", subject: "com.rndebuggertestapp", message: "Cmdline: com.rndebuggertestapp" })];
        const a = runNativePipeline(mk(), APP, "Pixel A", { minLevel: "warn" });
        const b = runNativePipeline(mk(), other, "Pixel B", { minLevel: "warn" });
        expect(a.events).toHaveLength(1);
        expect(b.events).toHaveLength(1);          // NOT deduped against device A
        expect(a.events[0].id).not.toBe(b.events[0].id);
    });
});
