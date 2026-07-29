import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const executeInApp = jest.fn<
    (
        expression: string,
        awaitPromise?: boolean,
        options?: Record<string, unknown>,
        device?: string
    ) => Promise<{ success: boolean; result?: string; error?: string }>
>();
jest.unstable_mockModule("../../core/jsExecute.js", () => ({
    executeInApp,
    markConnectionEstablished: jest.fn(),
}));

const { harvestStacksAtPoint, harvestStacksAtFrame } = await import("../../core/inspector.js");

const OK = {
    success: true,
    result: JSON.stringify({ stacks: [{ component: "Text", stack: "Error\n    at a (http://h:8081/b:1:1)" }] }),
};

describe("harvestStacksAtPoint", () => {
    beforeEach(() => {
        executeInApp.mockReset();
    });

    it("returns the harvested stacks", async () => {
        executeInApp.mockResolvedValueOnce(OK);
        const out = await harvestStacksAtPoint(210, 450);
        expect(out).toEqual([{ component: "Text", stack: "Error\n    at a (http://h:8081/b:1:1)" }]);
    });

    it("passes the coordinates into the expression", async () => {
        executeInApp.mockResolvedValueOnce(OK);
        await harvestStacksAtPoint(210, 450);
        const expr = executeInApp.mock.calls[0][0] as string;
        expect(expr).toContain("210");
        expect(expr).toContain("450");
    });

    it("returns an empty list when the evaluate fails", async () => {
        executeInApp.mockResolvedValueOnce({ success: false, error: "disconnected" });
        expect(await harvestStacksAtPoint(1, 2)).toEqual([]);
    });

    it("returns an empty list on unparseable output", async () => {
        executeInApp.mockResolvedValueOnce({ success: true, result: "not json" });
        expect(await harvestStacksAtPoint(1, 2)).toEqual([]);
    });

    it("returns an empty list when the evaluate throws", async () => {
        executeInApp.mockRejectedValueOnce(new Error("boom"));
        expect(await harvestStacksAtPoint(1, 2)).toEqual([]);
    });
});

describe("harvestStacksAtFrame", () => {
    beforeEach(() => {
        executeInApp.mockReset();
    });

    it("harvests at the centre of the frame", async () => {
        executeInApp.mockResolvedValueOnce(OK);
        await harvestStacksAtFrame({ left: 100, top: 200, width: 50, height: 20 });
        const expr = executeInApp.mock.calls[0][0] as string;
        expect(expr).toContain("125");
        expect(expr).toContain("210");
    });

    it("returns an empty list without evaluating for a null frame", async () => {
        expect(await harvestStacksAtFrame(null)).toEqual([]);
        expect(executeInApp.mock.calls.length).toBe(0);
    });

    it("returns an empty list without evaluating for an incomplete frame", async () => {
        expect(await harvestStacksAtFrame({ left: 1, top: 2 })).toEqual([]);
        expect(executeInApp.mock.calls.length).toBe(0);
    });
});
