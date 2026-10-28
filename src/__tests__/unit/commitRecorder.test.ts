import { describe, expect, it } from "@jest/globals";
import { settle, type CommitEntry } from "../../core/commitRecorder.js";

const at = (...times: number[]): CommitEntry[] => times.map((t) => ({ at: t, duration: 1, slowest: null, slowestMs: null }));

describe("settle", () => {
    it("ends the burst at the first gap over 500 ms", () => {
        const r = settle(at(100, 200, 450, 1100), 0, { now: 5000 });
        expect(r.commits).toBe(3);
        expect(r.settledAt).toBe(450);
    });

    it("ignores commits before the anchor", () => {
        expect(settle(at(-50, 10, 20), 0, { now: 5000 }).commits).toBe(2);
    });

    it("reports still rendering when the last commit is recent", () => {
        const r = settle(at(100, 300), 0, { now: 600 });
        expect(r.settledAt).toBeNull();
        expect(r.commits).toBe(2);
    });

    it("caps at 10 s", () => {
        const times: number[] = [];
        for (let t = 0; t <= 12_000; t += 200) times.push(t);
        const r = settle(at(...times), 0, { now: 20_000 });
        expect(r.settledAt).toBe(10_000);
        expect(r.commits).toBe(51);
    });

    it("sums durations and picks the slowest", () => {
        const commits: CommitEntry[] = [
            { at: 10, duration: 54, slowest: "SettingsHeader", slowestMs: 6.8 },
            { at: 20, duration: 4, slowest: "GeneralTab", slowestMs: 3.9 },
            { at: 30, duration: null, slowest: null, slowestMs: null },
        ];
        const r = settle(commits, 0, { now: 5000 });
        expect(r.totalMs).toBe(58);
        expect(r.slowest).toEqual({ name: "SettingsHeader", ms: 6.8 });
    });

    it("returns null total and slowest when every duration is null", () => {
        const commits: CommitEntry[] = [{ at: 10, duration: null, slowest: null, slowestMs: null }];
        const r = settle(commits, 0, { now: 5000 });
        expect(r.totalMs).toBeNull();
        expect(r.slowest).toBeNull();
    });

    it("returns an empty result when nothing committed after the anchor", () => {
        expect(settle(at(-10), 0, { now: 5000 })).toEqual({ commits: 0, totalMs: null, slowest: null, settledAt: null });
    });

    it("respects a custom gapMs", () => {
        const r = settle(at(100, 200, 450, 1100), 0, { now: 5000, gapMs: 1000 });
        expect(r.commits).toBe(4);
        expect(r.settledAt).toBe(1100);
    });
});
