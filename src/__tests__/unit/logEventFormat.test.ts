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
        // Non-message kind: sizeHint/frameHint decorate the one-line title.
        // Message-kind rows render their own body instead — see the
        // "message events" describe block below.
        const heavy = { ...EVENT, kind: "exception" as const, lineCount: 1, byteSize: 42_189 };
        expect(formatEventRow(heavy, { showDevice: false })).toContain("[41.2 KB]");
    });

    it("omits the size hint for small payloads", () => {
        const small = { ...EVENT, kind: "exception" as const, lineCount: 1, byteSize: 80 };
        expect(formatEventRow(small, { showDevice: false })).not.toContain("KB]");
    });

    it("keeps crash/anr/exception rows to a single line regardless of maxLength/verbose", () => {
        // EVENT is a 17-line crash. Compactness matters here: get_log_details
        // exists to expand it, so the row must stay the one-line title even
        // when the caller asks for full messages.
        const row = formatEventRow(EVENT, { showDevice: false, verbose: true, maxLength: 0 });
        expect(row.split("\n")).toHaveLength(1);
        expect(row).toContain("SIGABRT in libhermes.so (14 frames)");
        expect(row).not.toContain("frame 0");
    });
});

describe("formatEventRow — message events", () => {
    const MESSAGE_EVENT: LogEvent = {
        ...EVENT,
        kind: "message",
        title: "line one of the message",
        lineCount: 3,
        lines: [
            { ts: EVENT.ts, level: "error", pid: 0, tag: "console", message: "line one", raw: "line one of the message" },
            { ts: EVENT.ts, level: "error", pid: 0, tag: "console", message: "line two", raw: "line two, much longer content" },
            { ts: EVENT.ts, level: "error", pid: 0, tag: "console", message: "line three", raw: "line three, the end" },
        ],
    };

    it("renders the full multi-line payload when verbose", () => {
        const row = formatEventRow(MESSAGE_EVENT, { showDevice: false, verbose: true });
        expect(row).toContain("line one of the message");
        expect(row).toContain("line two, much longer content");
        expect(row).toContain("line three, the end");
    });

    it("honours maxLength (get_logs' maxMessageLength) when not verbose", () => {
        const row = formatEventRow(MESSAGE_EVENT, { showDevice: false, verbose: false, maxLength: 10 });
        expect(row).toContain("truncated");
        expect(row).not.toContain("line three, the end");
    });

    it("defaults the truncation budget to 500, matching get_logs' schema default", () => {
        const longRaw = "x".repeat(600);
        const longEvent: LogEvent = {
            ...MESSAGE_EVENT,
            lines: [{ ts: EVENT.ts, level: "error", pid: 0, tag: "console", message: longRaw, raw: longRaw }],
        };
        const row = formatEventRow(longEvent, { showDevice: false });
        expect(row).toContain("truncated: 600 chars");
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

    it("separates the header from the payload with a blank line", () => {
        // Regression test: filter(Boolean) used to drop the header's trailing
        // "" separator (falsy, indistinguishable from an absent optional
        // field), running "Lines: N" straight into the first payload line.
        const out = formatEventDetails(EVENT, { maxLength: 0, verbose: true });
        const headerEnd = out.indexOf("Lines: 17");
        expect(headerEnd).toBeGreaterThan(-1);
        const afterHeader = out.slice(headerEnd);
        // "Lines: 17" then a blank line then the first payload row.
        expect(afterHeader.startsWith("Lines: 17\n\nF DEBUG : frame 0")).toBe(true);
    });
});
