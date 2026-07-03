import { describe, expect, it } from "@jest/globals";
import { FlowpointEntry, verifyFlow } from "../../pro/flowpoints.js";

function e(seq: number, step: string, overrides: Partial<FlowpointEntry> = {}): FlowpointEntry {
    return { seq, t: 1000 + seq * 10, name: "add-to-cart", step, run: "r1", level: "info", ...overrides };
}

const happy = [e(1, "start"), e(2, "cleared"), e(3, "item-added"), e(4, "done")];

describe("verifyFlow", () => {
    it("passes when expected steps appear in order (subsequence: extras allowed)", () => {
        const result = verifyFlow("add-to-cart", "r1", happy, ["start", "item-added", "done"], false);
        expect(result.pass).toBe(true);
        expect(result.text).toContain('PASS — flow "add-to-cart" run r1:');
        expect(result.text).toContain("✓ start (+0ms)");
        expect(result.text).toContain("✓ done (+30ms)");
    });

    it("fails and diffs a missing step", () => {
        const result = verifyFlow(
            "add-to-cart",
            "r1",
            [e(1, "start"), e(2, "cleared")],
            ["start", "item-added"],
            false,
        );
        expect(result.pass).toBe(false);
        expect(result.text).toContain("✗ item-added — not seen");
    });

    it("fails on out-of-order steps", () => {
        const result = verifyFlow("add-to-cart", "r1", happy, ["done", "start"], false);
        expect(result.pass).toBe(false);
    });

    it("fails on an unexpected error point, with a ! line", () => {
        const entries = [e(1, "start"), e(2, "failed", { level: "error", meta: { reason: "timeout" } })];
        const result = verifyFlow("add-to-cart", "r1", entries, ["start"], false);
        expect(result.pass).toBe(false);
        expect(result.text).toContain('! failed [error] (+10ms) {"reason":"timeout"} — unexpected error point');
    });

    it("allowErrors tolerates unexpected error points", () => {
        const entries = [e(1, "start"), e(2, "failed", { level: "error" })];
        expect(verifyFlow("add-to-cart", "r1", entries, ["start"], true).pass).toBe(true);
    });

    it("an explicitly expected error step passes", () => {
        const entries = [e(1, "start"), e(2, "failed", { level: "error" })];
        const result = verifyFlow("add-to-cart", "r1", entries, ["start", { step: "failed", level: "error" }], false);
        expect(result.pass).toBe(true);
    });

    it("object matchers can constrain meta", () => {
        const entries = [e(1, "done", { meta: { count: 5 } })];
        expect(verifyFlow("f", "r1", entries, [{ step: "done", metaIncludes: '"count":5' }], false).pass).toBe(true);
        expect(verifyFlow("f", "r1", entries, [{ step: "done", metaIncludes: 'count":9' }], false).pass).toBe(false);
    });
});
