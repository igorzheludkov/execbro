import { describe, it, expect } from "@jest/globals";
import { groupIntoEvents } from "../../core/logGrouping.js";
import type { RawLogLine } from "../../core/logEvents.js";

const CTX = { deviceKey: "emulator-5554", deviceName: "Pixel", source: "native" as const };

let clock = 0;
function line(over: Partial<RawLogLine>): RawLogLine {
    clock += 1;
    return {
        ts: new Date(Date.UTC(2026, 6, 29, 22, 11, 5, clock)),
        level: "info",
        pid: 22617,
        tid: 22617,
        tag: "DEBUG",
        message: "",
        raw: "",
        ...over,
    };
}

describe("groupIntoEvents", () => {
    it("collapses a native backtrace into one crash event", () => {
        const lines = [
            line({ level: "fatal", message: "Cmdline: com.rndebuggertestapp", subject: "com.rndebuggertestapp" }),
            line({ level: "fatal", message: "pid: 17782, tid: 17832 >>> com.rndebuggertestapp <<<" }),
            line({ level: "fatal", message: "signal 6 (SIGABRT), code -1" }),
            ...Array.from({ length: 14 }, (_, i) =>
                line({ level: "fatal", message: `      #${String(i).padStart(2, "0")} pc 707b0 /apex/libc.so (abort+156)` })),
        ];
        const events = groupIntoEvents(lines, CTX);
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe("crash");
        expect(events[0].lineCount).toBe(17);
        expect(events[0].owner).toBe("com.rndebuggertestapp");
        expect(events[0].level).toBe("fatal");
    });

    it("keeps one event when foreign pids interleave the backtrace", () => {
        // logcat interleaves processes, so adjacency cannot define a group.
        const lines = [
            line({ level: "fatal", message: "Cmdline: com.rndebuggertestapp", subject: "com.rndebuggertestapp" }),
            line({ pid: 660, tid: 813, tag: "ConnectivityService", message: "NetReassign [no changes]" }),
            line({ level: "fatal", message: "signal 6 (SIGABRT), code -1" }),
            line({ pid: 1210, tid: 13886, tag: "NearbyMediums", message: "Wifi changed" }),
            line({ level: "fatal", message: "      #00 pc 707b0 /apex/libc.so (abort+156)" }),
        ];
        const events = groupIntoEvents(lines, CTX);
        const crash = events.find((e) => e.kind === "crash");
        expect(crash).toBeDefined();
        expect(crash!.lineCount).toBe(3);
        expect(events.filter((e) => e.kind === "message")).toHaveLength(2);
    });

    it("collapses a java FATAL EXCEPTION with its stack", () => {
        const lines = [
            line({ tag: "AndroidRuntime", level: "error", message: "FATAL EXCEPTION: main" }),
            line({ tag: "AndroidRuntime", level: "error", message: "Process: com.rndebuggertestapp, PID: 23325", subject: "com.rndebuggertestapp" }),
            line({ tag: "AndroidRuntime", level: "error", message: "java.lang.NullPointerException" }),
            line({ tag: "AndroidRuntime", level: "error", message: "\tat com.example.Foo.bar(Foo.java:42)" }),
            line({ tag: "AndroidRuntime", level: "error", message: "Caused by: java.lang.IllegalStateException" }),
        ];
        const events = groupIntoEvents(lines, CTX);
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe("crash");
        expect(events[0].title).toContain("NullPointerException");
    });

    it("recognizes an ANR", () => {
        const events = groupIntoEvents([
            line({ tag: "ActivityManager", level: "error", pid: 660, message: "ANR in com.rndebuggertestapp" }),
        ], CTX);
        expect(events[0].kind).toBe("anr");
    });

    it("emits one message event per unmatched line rather than dropping it", () => {
        const events = groupIntoEvents([
            line({ tag: "SoLoader", level: "warn", message: "couldn't find DSO to load" }),
        ], CTX);
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe("message");
        expect(events[0].title).toContain("couldn't find DSO");
    });

    it("sets byteSize from the raw payload", () => {
        const events = groupIntoEvents([line({ message: "hello", raw: "0123456789" })], CTX);
        expect(events[0].byteSize).toBe(10);
    });

    it("names the culprit library, not the abort machinery", () => {
        // Frame #00 of every abort is libc.so; the cause is deeper.
        const lines = [
            line({ level: "fatal", message: "Cmdline: com.rndebuggertestapp", subject: "com.rndebuggertestapp" }),
            line({ level: "fatal", message: "signal 6 (SIGABRT), code -1" }),
            line({ level: "fatal", message: "      #00 pc 707b0  /apex/com.android.runtime/lib64/bionic/libc.so (abort+156)" }),
            line({ level: "fatal", message: "      #01 pc 8fdfc4 /apex/com.android.art/lib64/libart.so (art::Runtime::Abort+1008)" }),
            line({ level: "fatal", message: "      #02 pc 1654c  /apex/com.android.art/lib64/libbase.so (android::base::SetAborter+80)" }),
            line({ level: "fatal", message: "      #03 pc d06d0c /apex/com.android.bt/lib64/libhermes.so (facebook::hermes::crash+836)" }),
        ];
        const [event] = groupIntoEvents(lines, CTX);
        expect(event.title).toContain("libhermes.so");
        expect(event.title).not.toContain("libc.so");
        expect(event.title).toContain("4 frames");
    });

    it("falls back to the first library when the whole backtrace is runtime machinery", () => {
        const lines = [
            line({ level: "fatal", message: "Cmdline: com.rndebuggertestapp", subject: "com.rndebuggertestapp" }),
            line({ level: "fatal", message: "signal 6 (SIGABRT), code -1" }),
            line({ level: "fatal", message: "      #00 pc 707b0 /apex/com.android.runtime/lib64/bionic/libc.so (abort+156)" }),
        ];
        const [event] = groupIntoEvents(lines, CTX);
        expect(event.title).toContain("libc.so");
    });
});
