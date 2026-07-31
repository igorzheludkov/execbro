import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { enrichWithSource } from "../../core/inspector.js";
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
