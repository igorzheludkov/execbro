import { describe, it, expect } from "@jest/globals";
import { fingerprintEvent, LEVEL_RANK, type RawLogLine } from "../../core/logEvents.js";

function line(over: Partial<RawLogLine> = {}): RawLogLine {
    return {
        ts: new Date("2026-07-29T22:11:05.015Z"),
        level: "fatal",
        pid: 22617,
        tag: "DEBUG",
        message: "signal 6 (SIGABRT), code -1",
        raw: "F DEBUG : signal 6 (SIGABRT), code -1",
        ...over,
    };
}

describe("fingerprintEvent", () => {
    it("is stable for identical input", () => {
        expect(fingerprintEvent([line()], "emulator-5554"))
            .toBe(fingerprintEvent([line()], "emulator-5554"));
    });

    it("differs across devices", () => {
        expect(fingerprintEvent([line()], "emulator-5554"))
            .not.toBe(fingerprintEvent([line()], "emulator-5556"));
    });

    it("differs when the timestamp differs", () => {
        const later = line({ ts: new Date("2026-07-29T22:11:06.015Z") });
        expect(fingerprintEvent([line()], "d")).not.toBe(fingerprintEvent([later], "d"));
    });

    it("ignores lines after the first, so a truncated refetch still matches", () => {
        // logcat -T is inclusive and the tail may be cut short mid-backtrace;
        // identity must come from the header line alone.
        const withTail = [line(), line({ message: "  #00 pc 707b0 libc.so" })];
        expect(fingerprintEvent(withTail, "d")).toBe(fingerprintEvent([line()], "d"));
    });
});

describe("LEVEL_RANK", () => {
    it("orders levels from debug up to fatal", () => {
        expect(LEVEL_RANK.debug).toBeLessThan(LEVEL_RANK.info);
        expect(LEVEL_RANK.info).toBeLessThan(LEVEL_RANK.warn);
        expect(LEVEL_RANK.warn).toBeLessThan(LEVEL_RANK.error);
        expect(LEVEL_RANK.error).toBeLessThan(LEVEL_RANK.fatal);
    });
});
