import { describe, expect, it, jest } from "@jest/globals";
import { getRefreshStatus, type ExecuteFn } from "../../core/fastRefreshTools.js";
import type { ExecutionResult } from "../../core/types.js";

function makeExecute(result: ExecutionResult) {
    return jest.fn<ExecuteFn>(async () => result);
}

describe("getRefreshStatus", () => {
    it("returns mapped fields on success", async () => {
        const execute = makeExecute({
            success: true,
            result: {
                lastUpdateAt: 1700000000000,
                updateCount: 2,
                recentUpdates: [
                    { at: 1700000000000, modulePath: "language-list-item.tsx" },
                    { at: 1699999999000, modulePath: "language-list-item.tsx" },
                ],
                _meta: { recorderInstalled: true, via: "performReactRefresh", justInstalled: false },
            } as unknown as string,
        });
        const r = await getRefreshStatus({}, execute);
        expect(r.success).toBe(true);
        expect(r.lastUpdateAt).toBe(1700000000000);
        expect(r.updateCount).toBe(2);
        expect(r.recentUpdates).toHaveLength(2);
        expect(r.justInstalled).toBe(false);
    });

    it("surfaces justInstalled:true on the bootstrap call", async () => {
        const execute = makeExecute({
            success: true,
            result: {
                lastUpdateAt: null,
                updateCount: 0,
                recentUpdates: [],
                _meta: { recorderInstalled: true, via: "performReactRefresh", justInstalled: true },
            } as unknown as string,
        });
        const r = await getRefreshStatus({}, execute);
        expect(r.success).toBe(true);
        expect(r.justInstalled).toBe(true);
        expect(r.updateCount).toBe(0);
    });

    it("returns failure when recorder install failed (no hook points)", async () => {
        const execute = makeExecute({
            success: true,
            result: {
                lastUpdateAt: null,
                updateCount: 0,
                recentUpdates: [],
                _meta: { recorderInstalled: false, via: null, reason: "no __ReactRefresh and no $RefreshReg$" },
            } as unknown as string,
        });
        const r = await getRefreshStatus({}, execute);
        expect(r.success).toBe(false);
        expect(r.error).toContain("no __ReactRefresh");
    });

    it("forwards executor errors verbatim", async () => {
        const execute = makeExecute({
            success: false,
            error: "No apps connected. Run 'scan_metro' first.",
        });
        const r = await getRefreshStatus({}, execute);
        expect(r.success).toBe(false);
        expect(r.error).toContain("No apps connected");
    });

    it("passes sincePath into the expression builder", async () => {
        const execute = makeExecute({
            success: true,
            result: {
                lastUpdateAt: null,
                updateCount: 0,
                recentUpdates: [],
                _meta: { recorderInstalled: true, via: "performReactRefresh" },
            } as unknown as string,
        });
        await getRefreshStatus({ sincePath: "language-list-item" }, execute);
        expect(execute.mock.calls[0][0]).toContain("language-list-item");
    });

    it("passes since epoch into the expression builder", async () => {
        const execute = makeExecute({
            success: true,
            result: {
                lastUpdateAt: null,
                updateCount: 0,
                recentUpdates: [],
                _meta: { recorderInstalled: true, via: "performReactRefresh" },
            } as unknown as string,
        });
        await getRefreshStatus({ since: 1700000000000 }, execute);
        expect(execute.mock.calls[0][0]).toContain("1700000000000");
    });

    it("propagates the device argument", async () => {
        const execute = makeExecute({
            success: true,
            result: {
                lastUpdateAt: null,
                updateCount: 0,
                recentUpdates: [],
                _meta: { recorderInstalled: true, via: "performReactRefresh" },
            } as unknown as string,
        });
        await getRefreshStatus({ device: "iPhone Air" }, execute);
        expect(execute.mock.calls[0][3]).toBe("iPhone Air");
    });

    it("rejects sincePath with double quotes via the builder", async () => {
        const execute = makeExecute({ success: true, result: "{}" as string });
        const r = await getRefreshStatus({ sincePath: '"; drop"' }, execute);
        expect(r.success).toBe(false);
        expect(r.error).toContain("double quotes");
        expect(execute).not.toHaveBeenCalled();
    });
});
