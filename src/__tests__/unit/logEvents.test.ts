import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    fingerprintEvent,
    LEVEL_RANK,
    type RawLogLine,
    NativeLogBuffer,
    getNativeLogBuffer,
    findNativeEvent,
    __resetNativeLogBuffers,
    type DraftEvent,
} from "../../core/logEvents.js";

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

    it("handles an empty line list without throwing", () => {
        expect(() => fingerprintEvent([], "emulator-5554")).not.toThrow();
    });

    it("cannot be forged by a separator inside a field", () => {
        // A raw join("|") would make these two collide.
        const a = fingerprintEvent([line({ tag: "Foo|bar", message: "x" })], "d");
        const b = fingerprintEvent([line({ tag: "Foo", message: "bar|x" })], "d");
        expect(a).not.toBe(b);
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

function draft(over: Partial<DraftEvent> = {}): DraftEvent {
    const lines = over.lines ?? [line()];
    return {
        source: "native",
        deviceKey: "emulator-5554",
        deviceName: "Pixel",
        ts: lines[0].ts,
        level: "fatal",
        kind: "crash",
        title: "SIGABRT in libhermes.so (14 frames)",
        owner: "com.rndebuggertestapp",
        lineCount: lines.length,
        byteSize: 400,
        fingerprint: fingerprintEvent(lines, over.deviceKey ?? "emulator-5554"),
        lines,
        ...over,
    };
}

describe("NativeLogBuffer", () => {
    beforeEach(() => __resetNativeLogBuffers());

    it("assigns sequential n-prefixed ids", () => {
        const buf = new NativeLogBuffer(50);
        const [a, b] = buf.ingest([draft(), draft({ lines: [line({ pid: 99 })] })]);
        expect(a.id).toMatch(/^n\d+$/);
        expect(b.id).not.toBe(a.id);
    });

    it("drops events already ingested", () => {
        const buf = new NativeLogBuffer(50);
        expect(buf.ingest([draft()])).toHaveLength(1);
        expect(buf.ingest([draft()])).toHaveLength(0);   // the inclusive -T repeat
        expect(buf.size).toBe(1);
    });

    it("advances the watermark to the newest ingested timestamp", () => {
        const buf = new NativeLogBuffer(50);
        const older = line({ ts: new Date("2026-07-29T22:00:00.000Z") });
        const newer = line({ ts: new Date("2026-07-29T22:30:00.000Z"), pid: 2 });
        buf.ingest([draft({ lines: [older], ts: older.ts }), draft({ lines: [newer], ts: newer.ts })]);
        expect(buf.watermark?.toISOString()).toBe(newer.ts.toISOString());
    });

    it("keeps the watermark after clear so cleared events do not return", () => {
        const buf = new NativeLogBuffer(50);
        buf.ingest([draft()]);
        const mark = buf.watermark;
        expect(buf.clear()).toBe(1);
        expect(buf.size).toBe(0);
        expect(buf.watermark).toEqual(mark);
        expect(buf.ingest([draft()])).toHaveLength(0);
    });

    it("resolves ids across devices without a device argument", () => {
        const a = getNativeLogBuffer("emulator-5554");
        const b = getNativeLogBuffer("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");
        const [ea] = a.ingest([draft({ deviceKey: "emulator-5554" })]);
        const [eb] = b.ingest([draft({ deviceKey: "F93612A3-0042-4BDC-855F-8CAB1BDD76C6", lines: [line({ pid: 7 })] })]);
        expect(ea.id).not.toBe(eb.id);
        expect(findNativeEvent(ea.id)?.deviceKey).toBe("emulator-5554");
        expect(findNativeEvent(eb.id)?.deviceKey).toBe("F93612A3-0042-4BDC-855F-8CAB1BDD76C6");
    });
});
