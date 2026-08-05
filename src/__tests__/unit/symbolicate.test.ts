import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
    parseStackString,
    symbolicateFrames,
    firstUserFrame,
    clearSymbolicateCache,
} from "../../core/symbolicate.js";

const BUNDLE =
    "http://192.168.0.102:8081/node_modules/expo/AppEntry.bundle//&platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes";

const REAL_STACK = [
    "Error: react-stack-top-frame",
    `    at anonymous (${BUNDLE}:19648:90)`,
    `    at HomeScreen (${BUNDLE}:342013:64)`,
    `    at react_stack_bottom_frame (${BUNDLE}:31478:29)`,
].join("\n");

describe("parseStackString", () => {
    it("parses named frames with URL, line and column", () => {
        const frames = parseStackString(REAL_STACK);
        expect(frames[0]).toEqual({
            file: BUNDLE,
            lineNumber: 19648,
            column: 90,
            methodName: "anonymous",
        });
        expect(frames[1].methodName).toBe("HomeScreen");
        expect(frames[1].lineNumber).toBe(342013);
    });

    it("does not split on the colon inside http://", () => {
        const frames = parseStackString(REAL_STACK);
        expect(frames[0].file).toBe(BUNDLE);
        expect(frames[0].file.startsWith("http://")).toBe(true);
    });

    it("skips the leading Error: line", () => {
        const frames = parseStackString(REAL_STACK);
        expect(frames.every((f) => f.methodName !== null)).toBe(true);
        expect(frames.length).toBe(3);
    });

    it("parses anonymous frames with no method name", () => {
        const frames = parseStackString(`    at ${BUNDLE}:100:5`);
        expect(frames[0]).toEqual({
            file: BUNDLE,
            lineNumber: 100,
            column: 5,
            methodName: null,
        });
    });

    it("honours the limit argument", () => {
        expect(parseStackString(REAL_STACK, 2).length).toBe(2);
    });

    it("returns an empty array for junk input", () => {
        expect(parseStackString("")).toEqual([]);
        expect(parseStackString("not a stack at all")).toEqual([]);
    });
});

describe("firstUserFrame", () => {
    it("returns the first frame not marked collapse", () => {
        const frame = firstUserFrame([
            { file: "/x/node_modules/react/a.js", lineNumber: 1, column: 1, methodName: "jsx", collapse: true },
            { file: "/x/src/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false },
        ]);
        expect(frame!.file).toBe("/x/src/Home.tsx");
        expect(frame!.lineNumber).toBe(105);
    });

    it("returns null when every frame is collapsed", () => {
        const frame = firstUserFrame([
            { file: "/x/node_modules/react/a.js", lineNumber: 1, column: 1, methodName: "jsx", collapse: true },
        ]);
        expect(frame).toBeNull();
    });

    it("returns null for an empty list", () => {
        expect(firstUserFrame([])).toBeNull();
    });
});

describe("symbolicateFrames", () => {
    beforeEach(() => {
        clearSymbolicateCache();
        (globalThis as any).fetch = jest.fn();
    });

    it("POSTs to localhost on the port taken from the frame URL", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [
                    { file: "/x/src/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false },
                ],
            }),
        });

        await symbolicateFrames([
            { file: BUNDLE, lineNumber: 342013, column: 64, methodName: "HomeScreen" },
        ]);

        const [url, init] = (globalThis.fetch as any).mock.calls[0];
        expect(url).toBe("http://127.0.0.1:8081/symbolicate");
        expect(init.method).toBe("POST");
        // The file field must be sent verbatim — Metro matches it against its bundle registry.
        expect(JSON.parse(init.body).stack[0].file).toBe(BUNDLE);
    });

    it("returns symbolicated frames with the collapse flag", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [
                    { file: "/x/src/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false },
                ],
            }),
        });

        const out = await symbolicateFrames([
            { file: BUNDLE, lineNumber: 342013, column: 64, methodName: "HomeScreen" },
        ]);
        expect(out).toEqual([
            { file: "/x/src/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false },
        ]);
    });

    it("defaults collapse to false when Metro omits it", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({ stack: [{ file: "/x/a.tsx", lineNumber: 1, column: 2, methodName: "A" }] }),
        });
        const out = await symbolicateFrames([{ file: BUNDLE, lineNumber: 1, column: 2, methodName: "A" }]);
        expect(out![0]!.collapse).toBe(false);
    });

    it("serves a repeated frame from cache without a second fetch", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [{ file: "/x/src/Home.tsx", lineNumber: 105, column: 10, methodName: "HomeScreen", collapse: false }],
            }),
        });

        const frame = { file: BUNDLE, lineNumber: 342013, column: 64, methodName: "HomeScreen" };
        await symbolicateFrames([frame]);
        const second = await symbolicateFrames([frame]);

        expect((globalThis.fetch as any).mock.calls.length).toBe(1);
        expect(second![0]!.file).toBe("/x/src/Home.tsx");
    });

    // The log path pairs frame N of the output with frame N of the input. An
    // earlier version filtered nulls out, which silently shortened the array
    // and mismapped every frame after the first unresolved one.
    it("keeps the result index-aligned when Metro resolves only some frames", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [
                    { file: "/x/src/A.tsx", lineNumber: 1, column: 1, methodName: "A", collapse: true },
                    null,
                    { file: "/x/src/C.tsx", lineNumber: 3, column: 3, methodName: "C", collapse: false },
                ],
            }),
        });

        const out = await symbolicateFrames([
            { file: BUNDLE, lineNumber: 10, column: 1, methodName: "A" },
            { file: BUNDLE, lineNumber: 20, column: 2, methodName: "B" },
            { file: BUNDLE, lineNumber: 30, column: 3, methodName: "C" },
        ]);

        expect(out).toHaveLength(3);
        expect(out![0]!.file).toBe("/x/src/A.tsx");
        expect(out![1]).toBeNull();
        expect(out![2]!.file).toBe("/x/src/C.tsx");
    });

    it("pads with nulls when Metro returns a shorter stack than requested", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                stack: [{ file: "/x/src/A.tsx", lineNumber: 1, column: 1, methodName: "A", collapse: false }],
            }),
        });

        const out = await symbolicateFrames([
            { file: BUNDLE, lineNumber: 10, column: 1, methodName: "A" },
            { file: BUNDLE, lineNumber: 20, column: 2, methodName: "B" },
        ]);

        expect(out).toHaveLength(2);
        expect(out![0]!.file).toBe("/x/src/A.tsx");
        expect(out![1]).toBeNull();
    });

    it("returns null when Metro is unreachable", async () => {
        (globalThis.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
        const out = await symbolicateFrames([{ file: BUNDLE, lineNumber: 1, column: 1, methodName: "A" }]);
        expect(out).toBeNull();
    });

    it("returns null on a non-ok response", async () => {
        (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const out = await symbolicateFrames([{ file: BUNDLE, lineNumber: 1, column: 1, methodName: "A" }]);
        expect(out).toBeNull();
    });

    it("returns an empty array without fetching when given no frames", async () => {
        const out = await symbolicateFrames([]);
        expect(out).toEqual([]);
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
    });

    it("falls back to the frame origin when the URL has no port", async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({ stack: [{ file: "/a.tsx", lineNumber: 1, column: 1, methodName: "A", collapse: false }] }),
        });
        await symbolicateFrames([
            { file: "http://example.com/bundle.js", lineNumber: 1, column: 1, methodName: "A" },
        ]);
        expect((globalThis.fetch as any).mock.calls[0][0]).toBe("http://example.com/symbolicate");
    });
});
