import { describe, it, expect } from "@jest/globals";
import { projectJson, projectJsonText } from "../../core/jsonProjection.js";

/**
 * The failure this module exists to prevent: a 40KB GraphQL response crossing
 * the wire twice to answer "is there an errors array" and "what is
 * .data.approvals.single.meetingItem.basicInfo.referenceNumber".
 */
describe("projectJson — no query (shape first)", () => {
    it("returns a small value untouched", () => {
        const value = { ok: true, id: "000342" };
        const out = projectJson(value, { maxBytes: 25000 });
        expect(out.text).toBe(JSON.stringify(value, null, 2));
        expect(out.budget.truncated).toBe(false);
        expect(out.matched).toBe(true);
    });

    it("keeps structure and reports real counts instead of clipping the head", () => {
        const value = {
            data: { items: Array.from({ length: 400 }, (_, i) => ({ id: i, blurb: "x".repeat(500) })) }
        };
        const out = projectJson(value, { maxBytes: 1500 });

        expect(out.budget.truncated).toBe(true);
        expect(out.text.length).toBeLessThanOrEqual(2000);
        // Still parseable and still navigable — the whole point.
        const parsed = JSON.parse(out.text) as { data: { items: unknown[] } };
        expect(parsed.data.items).toBeDefined();
        // The dropped count is stated, not silently lost.
        expect(out.text).toMatch(/…\+\d+ more/);
    });

    it("reveals that a deep field exists, which a char slice cannot", () => {
        const value = {
            documentId: "d1",
            data: { approvals: { single: { meetingItem: { basicInfo: { referenceNumber: "000342" } } } } },
            noise: Array.from({ length: 200 }, (_, i) => ({ i, pad: "y".repeat(200) }))
        };
        const out = projectJson(value, { maxBytes: 2000 });
        expect(out.text).toContain("referenceNumber");
        expect(out.text).toContain("000342");
    });

    it("survives cycles", () => {
        const value: Record<string, unknown> = { a: 1 };
        value.self = value;
        const out = projectJson(value, { maxBytes: 100 });
        expect(out.text).toContain("[Circular]");
    });
});

describe("projectJson — query resolution", () => {
    const value = {
        errors: undefined,
        data: {
            approvals: { single: { meetingItem: { basicInfo: { referenceNumber: "000342" } } } },
            items: [
                { id: 1, status: "ok" },
                { id: 2, status: "failed" }
            ],
            "weird.key": { inner: true }
        }
    };

    it("pulls a deep subtree in full", () => {
        const out = projectJson(value, { query: "data.approvals.single.meetingItem.basicInfo" });
        expect(out.matched).toBe(true);
        expect(JSON.parse(out.text)).toEqual({ referenceNumber: "000342" });
    });

    it("returns a scalar leaf", () => {
        const out = projectJson(value, {
            query: "data.approvals.single.meetingItem.basicInfo.referenceNumber"
        });
        expect(out.matched).toBe(true);
        expect(JSON.parse(out.text)).toBe("000342");
    });

    it("indexes arrays, including from the end", () => {
        expect(JSON.parse(projectJson(value, { query: "data.items[0].id" }).text)).toBe(1);
        expect(JSON.parse(projectJson(value, { query: "data.items[-1].id" }).text)).toBe(2);
    });

    it("collects wildcard matches into an array", () => {
        const out = projectJson(value, { query: "data.items[*].status" });
        expect(out.matched).toBe(true);
        expect(JSON.parse(out.text)).toEqual(["ok", "failed"]);
    });

    it("accepts a quoted key containing a dot", () => {
        const out = projectJson(value, { query: 'data["weird.key"].inner' });
        expect(JSON.parse(out.text)).toBe(true);
    });

    it("tolerates a leading $. from a JSONPath emitted from memory", () => {
        const out = projectJson(value, { query: "$.data.items[1].status" });
        expect(out.matched).toBe(true);
        expect(JSON.parse(out.text)).toBe("failed");
    });

    it("bounds an oversized subtree rather than dumping it", () => {
        const big = { data: { rows: Array.from({ length: 300 }, (_, i) => ({ i, pad: "z".repeat(300) })) } };
        const out = projectJson(big, { query: "data.rows", maxBytes: 1200 });
        expect(out.matched).toBe(true);
        expect(out.budget.truncated).toBe(true);
        expect(out.text.length).toBeLessThanOrEqual(1700);
    });
});

describe("projectJson — a miss is progress, not an error", () => {
    const value = { data: { approvals: { single: 1, batch: 2 } } };

    it("falls back to the shape and names the deepest segment that resolved", () => {
        const out = projectJson(value, { query: "data.approvals.singel" });
        expect(out.matched).toBe(false);
        expect(out.note).toContain("data.approvals");
        expect(out.note).toContain("singel");
        // The keys that ARE there, so the retry is informed.
        expect(out.note).toContain("single");
        // And the shape is still returned.
        expect(out.text).toContain("approvals");
    });

    it("reports a wildcard over a non-array without pretending it matched", () => {
        const out = projectJson(value, { query: "data.approvals.single[*]" });
        expect(out.matched).toBe(false);
        expect(out.note).toBeDefined();
    });

    it("reports an out-of-range index", () => {
        const out = projectJson({ items: [1] }, { query: "items[4]" });
        expect(out.matched).toBe(false);
        expect(out.note).toContain("items");
    });

    it("treats a malformed query as a miss with an explanation", () => {
        const out = projectJson(value, { query: "data[" });
        expect(out.matched).toBe(false);
        expect(out.note).toMatch(/quer/i);
        expect(out.text).toContain("approvals");
    });

    it("does not claim a miss when the matched value is legitimately null", () => {
        const out = projectJson({ errors: null }, { query: "errors" });
        expect(out.matched).toBe(true);
        expect(out.text).toBe("null");
    });
});

describe("projectJsonText", () => {
    it("parses JSON text and bounds it structurally", () => {
        const text = JSON.stringify({ a: Array.from({ length: 100 }, (_, i) => i) });
        const out = projectJsonText(text, { maxBytes: 120 });
        expect(out.isJson).toBe(true);
        expect(out.budget.truncated).toBe(true);
    });

    it("leaves non-JSON text alone apart from a clip", () => {
        const out = projectJsonText("<html>not json</html>", { maxBytes: 25000 });
        expect(out.isJson).toBe(false);
        expect(out.text).toBe("<html>not json</html>");
    });

    it("says so when a query is given for a non-JSON body", () => {
        const out = projectJsonText("plain text", { query: "a.b" });
        expect(out.isJson).toBe(false);
        expect(out.matched).toBe(false);
        expect(out.note).toMatch(/not JSON/i);
    });
});

describe("projectJsonText — identity", () => {
    it("returns text that already fits byte-identical, without reflowing it", () => {
        const compact = JSON.stringify({ ok: true, nested: { a: 1 } });
        const out = projectJsonText(compact, { maxBytes: 25000 });
        expect(out.text).toBe(compact);
        expect(out.budget.truncated).toBe(false);
    });
});
