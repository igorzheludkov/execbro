import { describe, it, expect } from "@jest/globals";
import { formatEventRow, formatEventDetails } from "../../core/logEventFormat.js";
import type { LogEvent } from "../../core/logEvents.js";

const EVENT: LogEvent = {
    id: "n7",
    source: "native",
    deviceKey: "emulator-5554",
    deviceName: "Pixel",
    ts: new Date("2026-07-29T19:11:05.015Z"),
    level: "fatal",
    kind: "crash",
    title: "SIGABRT in libhermes.so (14 frames)",
    owner: "com.rndebuggertestapp",
    lineCount: 17,
    byteSize: 2048,
    fingerprint: "abc123",
    lines: Array.from({ length: 17 }, (_, i) => ({
        ts: new Date("2026-07-29T19:11:05.015Z"),
        level: "fatal" as const,
        pid: 22617,
        tag: "DEBUG",
        message: `frame ${i}`,
        raw: `F DEBUG : frame ${i}`,
    })),
};

describe("formatEventRow", () => {
    it("leads with the addressable id", () => {
        expect(formatEventRow(EVENT, { showDevice: false })).toMatch(/^\[n7\]/);
    });

    it("includes level, owner and title", () => {
        const row = formatEventRow(EVENT, { showDevice: false });
        expect(row).toContain("FATAL");
        expect(row).toContain("com.rndebuggertestapp");
        expect(row).toContain("SIGABRT in libhermes.so (14 frames)");
    });

    it("adds the device column only when asked", () => {
        expect(formatEventRow(EVENT, { showDevice: false })).not.toContain("Pixel");
        expect(formatEventRow(EVENT, { showDevice: true })).toContain("Pixel");
    });

    it("shows a size hint for oversized payloads", () => {
        const heavy = { ...EVENT, kind: "message" as const, lineCount: 1, byteSize: 42_189 };
        expect(formatEventRow(heavy, { showDevice: false })).toContain("[41.2 KB]");
    });

    it("omits the size hint for small payloads", () => {
        const small = { ...EVENT, kind: "message" as const, lineCount: 1, byteSize: 80 };
        expect(formatEventRow(small, { showDevice: false })).not.toContain("KB]");
    });
});

describe("formatEventDetails", () => {
    it("includes a header and every raw line", () => {
        const out = formatEventDetails(EVENT, { maxLength: 0, verbose: true });
        expect(out).toContain("n7");
        expect(out).toContain("com.rndebuggertestapp");
        expect(out).toContain("frame 0");
        expect(out).toContain("frame 16");
    });

    it("truncates when not verbose", () => {
        const out = formatEventDetails(EVENT, { maxLength: 60, verbose: false });
        expect(out).toContain("truncated");
        expect(out).not.toContain("frame 16");
    });
});
