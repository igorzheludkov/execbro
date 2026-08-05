import { describe, it, expect } from "@jest/globals";
import { captureStack, toStackFrames, MAX_STORED_FRAMES } from "../../core/logStack.js";
import { CDPStackFrame } from "../../core/types.js";

const BUNDLE = "http://localhost:8081/index.bundle?platform=ios";

function cdpFrame(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        functionName: "doThing",
        scriptId: "10",
        url: BUNDLE,
        lineNumber: 100,
        columnNumber: 20,
        ...over,
    };
}

describe("captureStack", () => {
    it("keeps a stack for warn, error and fatal", () => {
        for (const level of ["warn", "error", "fatal"] as const) {
            const out = captureStack(level, { callFrames: [cdpFrame()] });
            expect(out).toHaveLength(1);
            expect(out![0].functionName).toBe("doThing");
        }
    });

    // Every consoleAPICalled carries a stack, including the network
    // interceptor's own __RN_NET__ debug lines. Storing them all would spend
    // memory on 2000 buffer rows nobody symbolicates.
    it("drops the stack for log, info and debug", () => {
        for (const level of ["log", "info", "debug"] as const) {
            expect(captureStack(level, { callFrames: [cdpFrame()] })).toBeUndefined();
        }
    });

    it("caps the number of stored frames", () => {
        const callFrames = Array.from({ length: MAX_STORED_FRAMES + 8 }, (_, i) =>
            cdpFrame({ lineNumber: i })
        );
        const out = captureStack("error", { callFrames });
        expect(out).toHaveLength(MAX_STORED_FRAMES);
        // Kept from the top of the stack, not the bottom.
        expect(out![0].lineNumber).toBe(0);
    });

    it("returns undefined for a missing, empty or malformed stackTrace", () => {
        expect(captureStack("error", undefined)).toBeUndefined();
        expect(captureStack("error", null)).toBeUndefined();
        expect(captureStack("error", "nope")).toBeUndefined();
        expect(captureStack("error", {})).toBeUndefined();
        expect(captureStack("error", { callFrames: [] })).toBeUndefined();
        expect(captureStack("error", { callFrames: "not-an-array" })).toBeUndefined();
    });

    it("skips frames without usable line/column rather than storing junk", () => {
        const out = captureStack("error", {
            callFrames: [
                { functionName: "bad" },
                cdpFrame({ functionName: "good" }),
                { functionName: "alsoBad", lineNumber: "3", columnNumber: 1 },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out![0].functionName).toBe("good");
    });

    it("normalizes an empty url to undefined", () => {
        // Runtime.evaluate frames arrive with url: "" — treating that as a real
        // file would send Metro a lookup it can never satisfy.
        const out = captureStack("error", { callFrames: [cdpFrame({ url: "" })] });
        expect(out![0].url).toBeUndefined();
    });
});

describe("toStackFrames", () => {
    // The measurement that motivated this: as-is resolved to the function
    // signature (ExceptionsManager.js:182), +1 to the real call site (:184).
    it("converts CDP 0-based line and column to Metro's 1-based", () => {
        const stored: CDPStackFrame[] = [
            { functionName: "handler", url: BUNDLE, lineNumber: 16973, columnNumber: 26 },
        ];
        expect(toStackFrames(stored)).toEqual([
            { file: BUNDLE, lineNumber: 16974, column: 27, methodName: "handler" },
        ]);
    });

    it("drops frames with no url, which Metro cannot resolve", () => {
        const stored: CDPStackFrame[] = [
            { functionName: "fromEval", lineNumber: 0, columnNumber: 5 },
            { functionName: "fromBundle", url: BUNDLE, lineNumber: 10, columnNumber: 1 },
        ];
        const out = toStackFrames(stored);
        expect(out).toHaveLength(1);
        expect(out[0].methodName).toBe("fromBundle");
    });

    it("maps an anonymous frame to a null methodName", () => {
        const stored: CDPStackFrame[] = [
            { functionName: "", url: BUNDLE, lineNumber: 1, columnNumber: 2 },
        ];
        expect(toStackFrames(stored)[0].methodName).toBeNull();
    });

    it("returns an empty array when nothing is symbolicatable", () => {
        expect(toStackFrames([{ lineNumber: 1, columnNumber: 2 }])).toEqual([]);
        expect(toStackFrames([])).toEqual([]);
    });
});
