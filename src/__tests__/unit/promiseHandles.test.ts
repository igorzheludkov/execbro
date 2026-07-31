import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    registerHandle,
    listHandles,
    dropHandle,
    clearHandlesForDevice,
    buildCollectExpression
} from "../../core/promiseHandles.js";

describe("promise handles", () => {
    beforeEach(() => {
        clearHandlesForDevice("iPhone Air");
        clearHandlesForDevice("pixel");
    });

    it("records a handle per device", () => {
        registerHandle("iPhone Air", "__rn_dbg_1_abc");
        expect(listHandles("iPhone Air")).toContain("__rn_dbg_1_abc");
        expect(listHandles("pixel")).toHaveLength(0);
    });

    it("drops a handle once collected", () => {
        registerHandle("iPhone Air", "__rn_dbg_1_abc");
        dropHandle("__rn_dbg_1_abc");
        expect(listHandles("iPhone Air")).toHaveLength(0);
    });

    it("clears every handle for a device on reload", () => {
        registerHandle("iPhone Air", "a");
        registerHandle("iPhone Air", "b");
        clearHandlesForDevice("iPhone Air");
        expect(listHandles("iPhone Air")).toHaveLength(0);
    });

    it("treats handles as dead after a device reset", () => {
        registerHandle("iPhone Air", "gone");
        clearHandlesForDevice("iPhone Air");
        expect(listHandles("iPhone Air")).not.toContain("gone");
    });

    it("builds ES5 collect source that deletes the slot when settled", () => {
        const src = buildCollectExpression("__rn_dbg_1_abc");
        expect(src).toContain("__rn_dbg_1_abc");
        expect(src).toContain("delete");
        expect(src).not.toMatch(/=>|\bconst\b|\blet\b/);
    });

    it("collect source reports pending without deleting the slot", () => {
        const src = buildCollectExpression("slot1");
        const run = new Function("globalThis", "return " + src + ";");
        const g: Record<string, unknown> = { slot1: { s: "pending" } };
        expect(run(g)).toBe("__pending__");
        expect(g.slot1).toBeDefined();
    });

    it("collect source returns and clears a settled value", () => {
        const src = buildCollectExpression("slot2");
        const run = new Function("globalThis", "return " + src + ";");
        const g: Record<string, unknown> = { slot2: { s: "ok", v: { total: 7 } } };
        expect(run(g)).toEqual({ status: "ok", value: { total: 7 } });
        expect(g.slot2).toBeUndefined();
    });

    it("collect source distinguishes a missing slot from a pending one", () => {
        const src = buildCollectExpression("slot3");
        const run = new Function("globalThis", "return " + src + ";");
        expect(run({})).toBe("__missing__");
    });

    it("collect source surfaces a rejected promise as an error status", () => {
        const src = buildCollectExpression("slot4");
        const run = new Function("globalThis", "return " + src + ";");
        const g: Record<string, unknown> = { slot4: { s: "err", v: "Network request failed" } };
        expect(run(g)).toEqual({ status: "err", value: "Network request failed" });
    });
});
