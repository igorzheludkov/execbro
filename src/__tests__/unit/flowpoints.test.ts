import { describe, expect, it } from "@jest/globals";
import {
    FlowpointEntry,
    FLOWPOINT_STORE_CAP,
    createFlowpointStore,
    applyDrain,
    buildDrainExpression,
    buildClearExpression,
    parseDrainResult,
} from "../../core/flowpoints.js";

function makeEntry(seq: number, overrides: Partial<FlowpointEntry> = {}): FlowpointEntry {
    return { seq, t: 1000 + seq, name: "add-to-cart", step: `step-${seq}`, run: "r1", level: "info", ...overrides };
}

describe("applyDrain", () => {
    it("appends everything on first drain and sets cursor/contextId", () => {
        const store = createFlowpointStore();
        const added = applyDrain(store, { contextId: "ctx-a", entries: [makeEntry(1), makeEntry(2)] });
        expect(added).toBe(2);
        expect(store.entries).toHaveLength(2);
        expect(store.cursor).toBe(2);
        expect(store.contextId).toBe("ctx-a");
    });

    it("is idempotent for the same snapshot and incremental for grown snapshots", () => {
        const store = createFlowpointStore();
        applyDrain(store, { contextId: "ctx-a", entries: [makeEntry(1)] });
        expect(applyDrain(store, { contextId: "ctx-a", entries: [makeEntry(1)] })).toBe(0);
        expect(applyDrain(store, { contextId: "ctx-a", entries: [makeEntry(1), makeEntry(2)] })).toBe(1);
        expect(store.entries.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("treats a changed contextId as a reload: all snapshot entries are fresh", () => {
        const store = createFlowpointStore();
        applyDrain(store, { contextId: "ctx-a", entries: [makeEntry(1), makeEntry(2), makeEntry(3)] });
        // reload: seq restarts, MORE entries than the old cursor — heuristics would miss this
        const added = applyDrain(store, {
            contextId: "ctx-b",
            entries: [makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4)],
        });
        expect(added).toBe(4);
        expect(store.entries).toHaveLength(7);
        expect(store.cursor).toBe(4);
        expect(store.contextId).toBe("ctx-b");
    });

    it("caps the store at FLOWPOINT_STORE_CAP, dropping oldest", () => {
        const store = createFlowpointStore();
        const entries = Array.from({ length: FLOWPOINT_STORE_CAP + 10 }, (_, i) => makeEntry(i + 1));
        applyDrain(store, { contextId: "ctx-a", entries });
        expect(store.entries).toHaveLength(FLOWPOINT_STORE_CAP);
        expect(store.entries[0].seq).toBe(11);
    });
});

describe("expression builders", () => {
    it("drain expression is an IIFE reading getFlowpointSnapshot with dual-global fallback", () => {
        const expr = buildDrainExpression();
        expect(expr).toContain("__EXECBRO__");
        expect(expr).toContain("__RN_AI_DEVTOOLS__");
        expect(expr).toContain("getFlowpointSnapshot");
        expect(expr).toContain("__missing");
        expect(expr).toContain("meta not JSON-serializable");
    });

    it("clear expression calls clearFlowpoints", () => {
        expect(buildClearExpression()).toContain("clearFlowpoints");
    });
});

describe("parseDrainResult", () => {
    it("parses a snapshot", () => {
        const parsed = parseDrainResult(JSON.stringify({ contextId: "c", entries: [makeEntry(1)] }));
        expect(parsed).toEqual({ contextId: "c", entries: [makeEntry(1)] });
    });

    it("detects the SDK-missing marker", () => {
        expect(parseDrainResult(JSON.stringify({ __missing: true }))).toEqual({ missing: true });
    });

    it("returns null on garbage", () => {
        expect(parseDrainResult("not json")).toBeNull();
    });
});
