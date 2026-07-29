import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

const executeInApp = jest.fn<
    (
        expression: string,
        awaitPromise?: boolean,
        options?: Record<string, unknown>,
        device?: string
    ) => Promise<{ success: boolean; result?: string; error?: string }>
>();
jest.unstable_mockModule("../../core/jsExecute.js", () => ({ executeInApp }));

const { pollOnce, startSelectionPoller, stopSelectionPoller, isSelectionPollerRunning } =
    await import("../../core/selectionPoller.js");
const { selectionBuffer } = await import("../../core/selectionBuffer.js");

function probeResult(overrides: Record<string, unknown> = {}) {
    return {
        success: true,
        result: JSON.stringify({
            active: true,
            selected: true,
            changed: true,
            element: "Text",
            path: "App > HomeScreen > Text",
            hierarchy: ["App", "HomeScreen", "Text"],
            frame: { left: 100, top: 200, width: 50, height: 20 },
            style: { fontSize: 17 },
            ...overrides,
        }),
    };
}

function harvestResult() {
    return {
        success: true,
        result: JSON.stringify({
            stacks: [{ component: "Text", stack: "Error\n    at anonymous (http://h:8081/b:1:1)" }],
        }),
    };
}

describe("selectionPoller", () => {
    beforeEach(() => {
        executeInApp.mockReset();
        selectionBuffer.clear();
        delete process.env.EXECBRO_DISABLE_SELECTION_POLL;
    });

    afterEach(() => {
        stopSelectionPoller("iPhone Air");
    });

    it("buffers an entry when the probe reports a change", async () => {
        executeInApp.mockResolvedValueOnce(probeResult()).mockResolvedValueOnce(harvestResult());

        const buffered = await pollOnce("iPhone Air");

        expect(buffered).toBe(true);
        expect(selectionBuffer.size).toBe(1);
        const entry = selectionBuffer.latest()!;
        expect(entry.element).toBe("Text");
        expect(entry.device).toBe("iPhone Air");
        expect(entry.stacks.length).toBe(1);
    });

    it("harvests at the centre of the inspected frame", async () => {
        executeInApp.mockResolvedValueOnce(probeResult()).mockResolvedValueOnce(harvestResult());
        await pollOnce("iPhone Air");

        // frame {left:100, top:200, width:50, height:20} -> centre (125, 210)
        const harvestExpr = executeInApp.mock.calls[1][0] as string;
        expect(harvestExpr).toContain("125");
        expect(harvestExpr).toContain("210");
    });

    it("does not harvest when nothing changed", async () => {
        executeInApp.mockResolvedValueOnce({
            success: true,
            result: JSON.stringify({ active: true, selected: true, changed: false }),
        });

        const buffered = await pollOnce("iPhone Air");

        expect(buffered).toBe(false);
        expect(executeInApp.mock.calls.length).toBe(1);
        expect(selectionBuffer.size).toBe(0);
    });

    it("does not harvest when the inspector is not mounted", async () => {
        executeInApp.mockResolvedValueOnce({
            success: true,
            result: JSON.stringify({ active: false, selected: false, changed: false }),
        });

        expect(await pollOnce("iPhone Air")).toBe(false);
        expect(executeInApp.mock.calls.length).toBe(1);
    });

    it("still buffers when the harvest fails, with empty stacks", async () => {
        executeInApp
            .mockResolvedValueOnce(probeResult())
            .mockResolvedValueOnce({ success: false, error: "timeout" });

        expect(await pollOnce("iPhone Air")).toBe(true);
        expect(selectionBuffer.latest()!.stacks).toEqual([]);
    });

    it("buffers without harvesting when the frame is null", async () => {
        executeInApp.mockResolvedValueOnce(probeResult({ frame: null }));

        expect(await pollOnce("iPhone Air")).toBe(true);
        expect(executeInApp.mock.calls.length).toBe(1);
        expect(selectionBuffer.latest()!.stacks).toEqual([]);
    });

    it("swallows a failed probe without throwing", async () => {
        executeInApp.mockResolvedValueOnce({ success: false, error: "disconnected" });
        await expect(pollOnce("iPhone Air")).resolves.toBe(false);
    });

    it("swallows unparseable probe output", async () => {
        executeInApp.mockResolvedValueOnce({ success: true, result: "not json" });
        await expect(pollOnce("iPhone Air")).resolves.toBe(false);
    });

    it("does not start when disabled by env var", () => {
        process.env.EXECBRO_DISABLE_SELECTION_POLL = "1";
        startSelectionPoller("iPhone Air");
        expect(isSelectionPollerRunning("iPhone Air")).toBe(false);
    });

    it("start is idempotent and stop halts it", () => {
        startSelectionPoller("iPhone Air");
        startSelectionPoller("iPhone Air");
        expect(isSelectionPollerRunning("iPhone Air")).toBe(true);
        stopSelectionPoller("iPhone Air");
        expect(isSelectionPollerRunning("iPhone Air")).toBe(false);
    });
});
