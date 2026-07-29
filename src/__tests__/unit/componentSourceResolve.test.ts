import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { resolveStacksToSource } from "../../core/componentSource.js";
import { clearSymbolicateCache } from "../../core/symbolicate.js";

const BUNDLE = "http://192.168.0.102:8081/AppEntry.bundle//&platform=ios&dev=true";

function stackFor(renderSiteLine: number): string {
    return [
        "Error: react-stack-top-frame",
        `    at anonymous (${BUNDLE}:19648:90)`,
        `    at HomeScreen (${BUNDLE}:${renderSiteLine}:64)`,
    ].join("\n");
}

describe("resolveStacksToSource", () => {
    beforeEach(() => {
        clearSymbolicateCache();
        (globalThis as any).fetch = jest.fn();
    });

    it("resolves the render-site frame (index 1) to a user source file", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [
                    { file: "/x/src/HomeScreen.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false },
                ],
            }),
        });

        const out = await resolveStacksToSource([{ component: "SearchBar", stack: stackFor(342013) }]);

        expect(out.source).toEqual({ file: "/x/src/HomeScreen.tsx", line: 105, column: 10 });
        expect(out.sourceUnavailable).toBeUndefined();
        // Only the render-site frame is sent, not the jsx-runtime frame.
        const sent = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
        expect(sent.stack.length).toBe(1);
        expect(sent.stack[0].lineNumber).toBe(342013);
    });

    it("returns ancestors for each component with a resolved frame", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [
                    { file: "/x/src/HomeScreen.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false },
                    { file: "/x/src/HomeScreen.tsx", lineNumber: 101, column: 8, methodName: "HomeScreen", collapse: false },
                ],
            }),
        });

        const out = await resolveStacksToSource([
            { component: "SearchBar", stack: stackFor(342013) },
            { component: "HomeScreen", stack: stackFor(342005) },
        ]);

        expect(out.ancestors).toEqual([
            { component: "SearchBar", file: "/x/src/HomeScreen.tsx", line: 105 },
            { component: "HomeScreen", file: "/x/src/HomeScreen.tsx", line: 101 },
        ]);
    });

    it("uses _debugSource directly without calling Metro", async () => {
        const out = await resolveStacksToSource([
            { component: "SearchBar", stack: "", file: "/x/src/HomeScreen.tsx", lineNumber: 105, column: 10 },
        ]);

        expect(out.source).toEqual({ file: "/x/src/HomeScreen.tsx", line: 105, column: 10 });
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
    });

    it("reports library-only when every frame is collapsed", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [
                    { file: "/x/node_modules/rn/ScrollView.js", lineNumber: 1942, column: 4, methodName: "Wrapper", collapse: true },
                ],
            }),
        });

        const out = await resolveStacksToSource([{ component: "ScrollView", stack: stackFor(70218) }]);
        expect(out.source).toBeNull();
        expect(out.sourceUnavailable).toBe("library-only");
    });

    it("reports symbolicate-unreachable when Metro is down", async () => {
        (globalThis.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
        const out = await resolveStacksToSource([{ component: "SearchBar", stack: stackFor(342013) }]);
        expect(out.source).toBeNull();
        expect(out.sourceUnavailable).toBe("symbolicate-unreachable");
        expect(out.ancestors).toEqual([]);
    });

    it("reports no-debug-stack for an empty stack list", async () => {
        const out = await resolveStacksToSource([]);
        expect(out.source).toBeNull();
        expect(out.sourceUnavailable).toBe("no-debug-stack");
    });

    it("reports no-debug-stack when stacks have no usable frames", async () => {
        const out = await resolveStacksToSource([{ component: "X", stack: "Error: nothing here" }]);
        expect(out.source).toBeNull();
        expect(out.sourceUnavailable).toBe("no-debug-stack");
    });
});
