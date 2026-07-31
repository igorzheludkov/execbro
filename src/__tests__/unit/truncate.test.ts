import { describe, it, expect } from "@jest/globals";
import { truncateToBudget } from "../../core/truncate.js";

describe("truncateToBudget", () => {
    it("returns small values byte-identical and reports no truncation", () => {
        const value = { entityDrawerOpen: false };
        const out = truncateToBudget(value, 25000);
        expect(out.truncated).toBe(false);
        expect(out.appliedBudget).toBeNull();
        expect(JSON.stringify(out.value)).toBe(JSON.stringify(value));
    });

    it("bounds a large array and preserves its true length in the marker", () => {
        const value = { data: Array.from({ length: 153 }, (_, i) => ({ id: i, a: 1, b: 2 })) };
        const out = truncateToBudget(value, 300);
        expect(out.truncated).toBe(true);
        expect(out.returnedBytes).toBeLessThanOrEqual(300);
        const rendered = JSON.stringify(out.value);
        expect(rendered).toContain("more");
        expect(rendered).toMatch(/\+1[0-9][0-9] more/);
    });

    it("survives circular references instead of throwing", () => {
        const a: Record<string, unknown> = { name: "root" };
        a.self = a;
        const out = truncateToBudget(a, 25000);
        // `truncated` reports "content was elided", and a cycle always is —
        // it cannot be represented in JSON. Sibling keys survive intact.
        expect(out.truncated).toBe(true);
        expect(JSON.stringify(out.value)).toContain("[Circular]");
        expect((out.value as Record<string, unknown>).name).toBe("root");
    });

    it("keeps repeated (non-circular) references intact", () => {
        // A shared child appearing twice is not a cycle — marking the second
        // occurrence "[Circular]" would be a false positive, so `seen` must be
        // path-scoped rather than global.
        const shared = { id: 7 };
        const out = truncateToBudget({ first: shared, second: shared }, 25000);
        expect(out.truncated).toBe(false);
        expect(JSON.stringify(out.value)).toBe(JSON.stringify({ first: { id: 7 }, second: { id: 7 } }));
    });

    it("reports original and returned byte counts", () => {
        const value = { s: "x".repeat(5000) };
        const out = truncateToBudget(value, 200);
        expect(out.originalBytes).toBeGreaterThan(5000);
        expect(out.returnedBytes).toBeLessThanOrEqual(200);
        expect(out.appliedBudget).not.toBeNull();
    });

    it("honours an explicit budget over the adaptive ladder", () => {
        const value = { arr: [1, 2, 3, 4, 5, 6, 7, 8] };
        const out = truncateToBudget(value, 25000, { maxArrayItems: 2 });
        expect(JSON.stringify(out.value)).toContain("+6 more");
    });

    it("marks objects and arrays elided by depth with their sizes", () => {
        const value = { a: { b: { c: { d: { e: [1, 2, 3] } } } } };
        const out = truncateToBudget(value, 25000, { maxDepth: 2 });
        const rendered = JSON.stringify(out.value);
        expect(rendered).toContain("{Object(");
    });
});
