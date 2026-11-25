import { describe, it, expect, beforeEach } from "@jest/globals";
import { LogBuffer, formatLogs } from "../../core/logs.js";

const t = (s: number) => new Date(2026, 10, 26, 12, 0, s);

// Lines recovered from the system log land before the live CDP lines of the
// same run, once. Each assertion below fails if the insert position, the seam
// dedupe or the eviction count is wrong.
describe("LogBuffer.insertBackfill", () => {
    let b: LogBuffer;
    beforeEach(() => {
        b = new LogBuffer(100, "iPhone 17");
    });

    it("inserts before the first live line of the epoch, in time order", () => {
        b.add({ timestamp: t(10), level: "log", message: "live1", epoch: 1 });
        b.add({ timestamp: t(11), level: "log", message: "live2", epoch: 1 });
        expect(b.insertBackfill([
            { timestamp: t(3), level: "info", message: "b", origin: "systemLog" },
            { timestamp: t(2), level: "info", message: "a", origin: "systemLog" },
        ], 1)).toBe(2);
        expect(b.getAll().map((e) => e.message)).toEqual(["a", "b", "live1", "live2"]);
        expect(b.getAll()[0]).toMatchObject({ epoch: 1, origin: "systemLog" });
        expect(new Set(b.getAll().map((e) => e.seq)).size).toBe(4);
    });

    it("keeps an earlier epoch's lines ahead of the backfill", () => {
        b.add({ timestamp: t(1), level: "log", message: "old run", epoch: 1 });
        b.add({ timestamp: t(10), level: "log", message: "live", epoch: 2 });
        b.insertBackfill([{ timestamp: t(5), level: "info", message: "startup", origin: "systemLog" }], 2);
        expect(b.getAll().map((e) => e.message)).toEqual(["old run", "startup", "live"]);
    });

    it("drops a line the buffer already holds within 2 s in the same epoch", () => {
        b.add({ timestamp: t(10), level: "log", message: "Screen mounted", epoch: 1 });
        expect(b.insertBackfill([{ timestamp: new Date(t(10).getTime() - 800), level: "info", message: "Screen mounted", origin: "systemLog" }], 1)).toBe(0);
        expect(b.insertBackfill([{ timestamp: t(7), level: "info", message: "Screen mounted", origin: "systemLog" }], 1)).toBe(1);
        expect(b.insertBackfill([{ timestamp: t(10), level: "info", message: "Screen mounted", origin: "systemLog" }], 2)).toBe(1);
    });

    it("evicts the oldest past maxSize and counts it", () => {
        const small = new LogBuffer(3, "iPhone 17");
        small.add({ timestamp: t(10), level: "log", message: "live1", epoch: 1 });
        small.add({ timestamp: t(11), level: "log", message: "live2", epoch: 1 });
        small.insertBackfill([
            { timestamp: t(1), level: "info", message: "a", origin: "systemLog" },
            { timestamp: t(2), level: "info", message: "b", origin: "systemLog" },
        ], 1);
        expect(small.size).toBe(3);
        expect(small.droppedCount).toBe(1);
        expect(small.getAll().map((e) => e.message)).toEqual(["b", "live1", "live2"]);
    });
});

describe("formatLogs", () => {
    it("marks system-log lines", () => {
        expect(formatLogs([{ timestamp: t(1), level: "info", message: "x", seq: 1, epoch: 1, origin: "systemLog" }])).toContain("[INFO] (syslog) x");
    });

    it("leaves live lines unmarked", () => {
        expect(formatLogs([{ timestamp: t(1), level: "info", message: "x", seq: 1, epoch: 1 }])).not.toContain("(syslog)");
    });
});
