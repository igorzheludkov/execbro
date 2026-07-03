import { describe, expect, it } from "@jest/globals";
import {
    FlowpointEntry,
    formatMeta,
    matchesPoint,
    resolveLastRuns,
    filterFlowpoints,
    formatFlowpoints,
} from "../../pro/flowpoints.js";

function e(seq: number, overrides: Partial<FlowpointEntry> = {}): FlowpointEntry {
    return { seq, t: 1000 + seq, name: "add-to-cart", step: `s${seq}`, run: "r1", level: "info", ...overrides };
}

describe("formatMeta", () => {
    it("passes strings through and stringifies objects", () => {
        expect(formatMeta("start")).toBe("start");
        expect(formatMeta({ removed: 3 })).toBe('{"removed":3}');
        expect(formatMeta(undefined)).toBe("");
    });
});

describe("matchesPoint", () => {
    it("matches on step equality, level, and case-insensitive metaIncludes", () => {
        const entry = e(1, { step: "failed", level: "error", meta: { reason: "Timeout" } });
        expect(matchesPoint(entry, { step: "failed" })).toBe(true);
        expect(matchesPoint(entry, { step: "other" })).toBe(false);
        expect(matchesPoint(entry, { level: "error" })).toBe(true);
        expect(matchesPoint(entry, { metaIncludes: "timeout" })).toBe(true);
        expect(matchesPoint(entry, { step: "failed", level: "info" })).toBe(false);
    });
});

describe("resolveLastRuns", () => {
    it("returns the run of the chronologically last entry per flow", () => {
        const entries = [
            e(1, { run: "aaaa" }),
            e(2, { run: "aaaa" }),
            e(3, { run: "bbbb" }),
            e(4, { name: "other", run: "cccc" }),
        ];
        const last = resolveLastRuns(entries);
        expect(last.get("add-to-cart")).toBe("bbbb");
        expect(last.get("other")).toBe("cccc");
    });
});

describe("filterFlowpoints", () => {
    const entries = [
        e(1, { run: "aaaa", step: "start" }),
        e(2, { run: "aaaa", step: "failed", level: "error", meta: { reason: "timeout" } }),
        e(3, { run: "bbbb", step: "start" }),
        e(4, { run: "bbbb", step: "done" }),
        e(5, { name: "checkout", run: "cccc", step: "start" }),
    ];

    it("filters by name, step, and level", () => {
        expect(filterFlowpoints(entries, { name: "checkout" })).toHaveLength(1);
        expect(filterFlowpoints(entries, { step: "start" })).toHaveLength(3);
        expect(filterFlowpoints(entries, { level: "error" })).toHaveLength(1);
    });

    it("filters by metaIncludes and since", () => {
        expect(filterFlowpoints(entries, { metaIncludes: "TIMEOUT" })).toHaveLength(1);
        expect(filterFlowpoints(entries, { since: 1003 })).toHaveLength(2);
    });

    it("resolves run: 'last' per flow and explicit run ids", () => {
        const last = filterFlowpoints(entries, { run: "last" });
        expect(last.map((x) => x.seq)).toEqual([3, 4, 5]);
        expect(filterFlowpoints(entries, { run: "aaaa" })).toHaveLength(2);
    });

    it("applies limit keeping the newest entries", () => {
        expect(filterFlowpoints(entries, { limit: 2 }).map((x) => x.seq)).toEqual([4, 5]);
    });
});

describe("formatFlowpoints", () => {
    it("formats a single-run flow with deltas, span, level prefix, and meta", () => {
        const out = formatFlowpoints([
            e(1, { step: "start", t: 1000 }),
            e(2, { step: "cleared", t: 1006, meta: { removed: 3 } }),
            e(3, { step: "failed", t: 1312, level: "error", meta: { reason: "timeout" } }),
        ]);
        expect(out).toContain('Flow "add-to-cart" run r1 — 3 points (312ms span):');
        expect(out).toContain("+0ms");
        expect(out).toContain("+6ms");
        expect(out).toContain('cleared  {"removed":3}');
        expect(out).toContain("[error] failed");
    });

    it("groups multiple runs and labels the latest", () => {
        const out = formatFlowpoints([e(1, { run: "aaaa", t: 1000 }), e(2, { run: "bbbb", t: 2000 })]);
        expect(out).toContain('Flow "add-to-cart" — 2 runs');
        expect(out).toContain("run aaaa — 1 points");
        expect(out).toContain("run bbbb (latest) — 1 points");
    });

    it("labels (latest) by last activity, not first appearance, under interleaved runs", () => {
        const out = formatFlowpoints([
            e(1, { run: "aaaa", t: 1000 }),
            e(2, { run: "bbbb", t: 1500 }),
            e(3, { run: "aaaa", t: 2000 }),
        ]);
        expect(out).toContain("run aaaa (latest)");
        expect(out).not.toContain("bbbb (latest)");
    });
});
