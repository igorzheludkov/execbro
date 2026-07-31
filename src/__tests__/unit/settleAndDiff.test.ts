import { describe, it, expect } from "@jest/globals";
import {
    settleAndDiff,
    SETTLE_POLL_START_MS,
    SETTLE_STABLE_TIMEOUT_MS,
    NO_CHANGE_CONFIRM_MS,
    type SettleFrame,
} from "../../pro/verifyAction.js";

const frame = (tag: string): SettleFrame => ({
    buffer: Buffer.from(tag),
    width: 100,
    height: 200,
    scaleFactor: 1,
});

/**
 * Fake clock + fake capture/compare so the settle loop is exercised without a
 * device. `compare` treats two buffers as "unchanged" when their bytes match,
 * which mirrors what compareScreenshots reports for identical frames.
 */
function harness(script: string[], opts: { captureCostMs?: number } = {}) {
    const captureCostMs = opts.captureCostMs ?? 200;
    let clock = 0;
    let captures = 0;
    const sleeps: number[] = [];
    return {
        get elapsed() { return clock; },
        get captures() { return captures; },
        sleeps,
        args: {
            beforeBuffer: Buffer.from("before"),
            statusBarHeight: 59,
            capture: async () => {
                // Frames are consumed in order; the last one repeats forever.
                const tag = script[Math.min(captures, script.length - 1)];
                captures++;
                clock += captureCostMs;
                return tag === "__fail__" ? null : frame(tag);
            },
            compare: async (a: Buffer, b: Buffer) => {
                const same = a.equals(b);
                clock += 10;
                return {
                    changed: !same,
                    changeRate: same ? 0 : 0.5,
                    changedPixels: same ? 0 : 5000,
                    totalPixels: 10000,
                };
            },
            now: () => clock,
            sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
        },
    };
}

describe("settleAndDiff", () => {
    it("returns as soon as the screen changed and two consecutive frames match", async () => {
        // "a" differs from before and repeats -> stable on the second capture.
        const h = harness(["a", "a", "a", "a"]);
        const result = await settleAndDiff(h.args);

        expect(result).not.toBeNull();
        expect(result!.settled).toBe(true);
        expect(result!.diff.changedPixels).toBeGreaterThan(0);
        expect(h.captures).toBe(2);
        // 150ms lead-in + 2 captures — well under the old fixed 800ms wait.
        expect(h.elapsed).toBeLessThan(700);
        expect(h.sleeps[0]).toBe(SETTLE_POLL_START_MS);
    });

    it("keeps polling while the screen is still animating", async () => {
        // Every frame differs from the previous one until the last pair.
        const h = harness(["a", "b", "c", "c"]);
        const result = await settleAndDiff(h.args);

        expect(result!.settled).toBe(true);
        expect(result!.frame.buffer.toString()).toBe("c");
        expect(h.captures).toBe(4);
    });

    it("catches a late change that starts after the screen first looked idle", async () => {
        // Identical to `before` twice (idle), then a modal slides in and settles.
        const h = harness(["before", "before", "late", "late"]);
        const result = await settleAndDiff(h.args);

        expect(result!.settled).toBe(true);
        expect(result!.diff.changedPixels).toBeGreaterThan(0);
        expect(result!.frame.buffer.toString()).toBe("late");
    });

    it("honours a caller-supplied no-change window (Android emulators animate slower)", async () => {
        const h = harness(["before", "before", "before", "before", "before", "before", "before"]);
        const result = await settleAndDiff({ ...h.args, noChangeConfirmMs: 1500 });

        expect(result!.diff.changedPixels).toBe(0);
        expect(h.elapsed).toBeGreaterThanOrEqual(1500);
    });

    it("confirms 'no change' only after the confirmation window", async () => {
        const h = harness(["before", "before", "before", "before", "before", "before"]);
        const result = await settleAndDiff(h.args);

        expect(result!.settled).toBe(true);
        expect(result!.diff.changedPixels).toBe(0);
        expect(h.elapsed).toBeGreaterThanOrEqual(NO_CHANGE_CONFIRM_MS);
        // ...but it must not burn the full stable timeout on a quiet screen.
        expect(h.elapsed).toBeLessThan(SETTLE_STABLE_TIMEOUT_MS + 500);
    });

    it("gives up at the cap when the screen never stabilises", async () => {
        const h = harness(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
        const result = await settleAndDiff(h.args);

        expect(result!.settled).toBe(false);
        expect(result!.diff).toBeDefined();
        expect(h.elapsed).toBeLessThan(SETTLE_STABLE_TIMEOUT_MS + 600);
    });

    it("returns null when the first capture fails", async () => {
        const h = harness(["__fail__"]);
        expect(await settleAndDiff(h.args)).toBeNull();
    });

    it("falls back to the last good frame when a later capture fails", async () => {
        const h = harness(["a", "__fail__"]);
        const result = await settleAndDiff(h.args);
        expect(result).not.toBeNull();
        expect(result!.frame.buffer.toString()).toBe("a");
    });
});
