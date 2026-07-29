import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { enrichWithSource, getSelectionHistory } from "../../core/inspector.js";
import { selectionBuffer } from "../../core/selectionBuffer.js";
import { clearSymbolicateCache } from "../../core/symbolicate.js";

const BUNDLE = "http://192.168.0.102:8081/AppEntry.bundle//&platform=ios";
const STACK = ["Error: top", `    at anonymous (${BUNDLE}:1:1)`, `    at HomeScreen (${BUNDLE}:342013:64)`].join("\n");

describe("enrichWithSource", () => {
    beforeEach(() => {
        clearSymbolicateCache();
        (globalThis as any).fetch = jest.fn();
    });

    it("adds source and ancestors to the payload", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [{ file: "/x/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false }],
            }),
        });

        const out = await enrichWithSource({ element: "Text" }, [{ component: "Text", stack: STACK }]);

        expect(out.element).toBe("Text");
        expect(out.source).toEqual({ file: "/x/Home.tsx", line: 105, column: 10 });
        expect(out.ancestors).toEqual([{ component: "Text", file: "/x/Home.tsx", line: 105 }]);
    });

    it("preserves the payload and attaches a reason when unavailable", async () => {
        const out = await enrichWithSource({ element: "Text", path: "a > b" }, []);
        expect(out.element).toBe("Text");
        expect(out.path).toBe("a > b");
        expect(out.source).toBeUndefined();
        expect(out.sourceUnavailable).toBe("no-debug-stack");
    });

    it("never throws when Metro is unreachable", async () => {
        (globalThis.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
        const out = await enrichWithSource({ element: "Text" }, [{ component: "Text", stack: STACK }]);
        expect(out.element).toBe("Text");
        expect(out.sourceUnavailable).toBe("symbolicate-unreachable");
    });
});

describe("getSelectionHistory", () => {
    beforeEach(() => {
        clearSymbolicateCache();
        selectionBuffer.clear();
        (globalThis as any).fetch = jest.fn();
    });

    it("returns buffered entries newest first with resolved source", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [{ file: "/x/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false }],
            }),
        });

        selectionBuffer.add({
            id: "s1", device: "iPhone Air", timestamp: 1,
            element: "Text", path: "App > Text", hierarchy: ["App", "Text"],
            frame: { left: 1, top: 2, width: 3, height: 4 }, style: null,
            stacks: [{ component: "Text", stack: STACK }],
        });

        const out = await getSelectionHistory({ limit: 5 });

        expect(out.length).toBe(1);
        expect(out[0].element).toBe("Text");
        expect(out[0].source).toEqual({ file: "/x/Home.tsx", line: 105, column: 10 });
    });

    it("returns an empty array when the buffer is empty", async () => {
        expect(await getSelectionHistory({})).toEqual([]);
    });

    it("filters by device", async () => {
        selectionBuffer.add({
            id: "s1", device: "Pixel 7", timestamp: 1, element: "A", path: "A",
            hierarchy: ["A"], frame: null, style: null, stacks: [],
        });
        expect((await getSelectionHistory({ device: "iPhone Air" })).length).toBe(0);
        expect((await getSelectionHistory({ device: "Pixel 7" })).length).toBe(1);
    });
});
