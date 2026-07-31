import { LogBuffer, __resetLogSeq } from "../../core/logs.js";
import { bumpEpoch, resetEpochs } from "../../core/state.js";

const entry = (message: string) => ({
    timestamp: new Date(),
    level: "log" as const,
    message,
});

describe("LogBuffer.get returns the newest entries", () => {
    beforeEach(() => { __resetLogSeq(); resetEpochs(); });

    it("returns the last N, not the first N", () => {
        const buf = new LogBuffer(10, "dev");
        for (let i = 1; i <= 5; i++) buf.add(entry(`m${i}`));
        expect(buf.get(2).map(e => e.message)).toEqual(["m4", "m5"]);
    });

    it("search returns the newest matches", () => {
        const buf = new LogBuffer(10, "dev");
        for (let i = 1; i <= 5; i++) buf.add(entry(`hit ${i}`));
        expect(buf.search("hit", 2).map(e => e.message)).toEqual(["hit 4", "hit 5"]);
    });
});

describe("LogBuffer epoch stamping", () => {
    beforeEach(() => { __resetLogSeq(); resetEpochs(); });

    it("stamps the device's current epoch", () => {
        const buf = new LogBuffer(10, "dev");
        buf.add(entry("before"));
        bumpEpoch("dev");
        buf.add(entry("after"));
        expect(buf.getAll().map(e => e.epoch)).toEqual([1, 2]);
    });

    it("preserves an explicitly supplied epoch (merged read buffers)", () => {
        const merged = new LogBuffer(10);
        merged.add({ ...entry("copied"), seq: 7, epoch: 3 });
        expect(merged.getAll()[0].epoch).toBe(3);
    });

    it("filters by epoch", () => {
        const buf = new LogBuffer(10, "dev");
        buf.add(entry("old"));
        bumpEpoch("dev");
        buf.add(entry("new"));
        expect(buf.get(10, undefined, undefined, 2).map(e => e.message)).toEqual(["new"]);
    });
});

describe("LogBuffer eviction accounting", () => {
    beforeEach(() => { __resetLogSeq(); resetEpochs(); });

    it("counts evicted entries", () => {
        const buf = new LogBuffer(3, "dev");
        for (let i = 1; i <= 5; i++) buf.add(entry(`m${i}`));
        expect(buf.size).toBe(3);
        expect(buf.droppedCount).toBe(2);
    });

    it("resets the dropped count on clear", () => {
        const buf = new LogBuffer(1, "dev");
        buf.add(entry("a"));
        buf.add(entry("b"));
        expect(buf.droppedCount).toBe(1);
        buf.clear();
        expect(buf.droppedCount).toBe(0);
    });
});
