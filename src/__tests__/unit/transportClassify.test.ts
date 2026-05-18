import { describe, expect, it } from "@jest/globals";
import { classifyTransportError } from "../../core/jsExecute.js";

describe("classifyTransportError — positive cases", () => {
    it("matches 'No apps connected'", () => {
        expect(classifyTransportError("No apps connected. Run 'scan_metro' first.", "logical")).toMatchObject({
            kind: "transport",
            pattern: "no_apps",
        });
    });
    it("matches ECONNRESET", () => {
        expect(classifyTransportError("read ECONNRESET", "logical")).toMatchObject({
            kind: "transport",
            pattern: "ws_closed",
        });
    });
    it("matches WebSocket-not-open text from current wrapper", () => {
        expect(classifyTransportError("WebSocket connection is not open.", "logical")).toMatchObject({
            kind: "transport",
            pattern: "ws_closed",
        });
    });
    it("matches 'target closed' wasThrown payload", () => {
        expect(classifyTransportError("Error: target closed", "cdp")).toMatchObject({
            kind: "transport",
            pattern: "target_closed",
        });
    });
    it("matches 'Inspector detached'", () => {
        expect(classifyTransportError("Inspector detached from the page", "cdp")).toMatchObject({
            kind: "transport",
            pattern: "target_closed",
        });
    });
    it("matches CDP-side 'Expression took too long to evaluate'", () => {
        expect(classifyTransportError("Expression took too long to evaluate", "cdp")).toMatchObject({
            kind: "transport",
            pattern: "cdp_eval_too_long",
        });
    });
});

describe("classifyTransportError — negative cases (must NOT auto-retry)", () => {
    it("does NOT match server-side timer text", () => {
        const serverTimerMsg = "Timeout: Expression took too long to evaluate.\n\nConnection state: ws=OPEN...";
        expect(classifyTransportError(serverTimerMsg, "server-timer")).toEqual({ kind: "logical" });
    });
    it("does NOT match 'no component matched'", () => {
        expect(classifyTransportError("No component matched pattern Foo", "logical")).toEqual({ kind: "logical" });
    });
    it("does NOT match Hermes ReferenceError", () => {
        expect(classifyTransportError("ReferenceError: __FOO__ is not defined", "logical")).toEqual({
            kind: "logical",
        });
    });
    it("does NOT match an expression that threw", () => {
        expect(classifyTransportError("Uncaught TypeError: Cannot read property 'x' of undefined", "logical")).toEqual({
            kind: "logical",
        });
    });
});
