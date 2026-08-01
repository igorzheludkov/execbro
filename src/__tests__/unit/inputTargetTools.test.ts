import { describe, expect, it, jest } from "@jest/globals";
import { runInputOp, type ExecuteFn } from "../../core/inputTargetTools.js";

const ok = (payload: unknown): ExecuteFn => async () => ({ success: true, result: JSON.stringify(payload) });

describe("runInputOp", () => {
    it("parses a found result", async () => {
        const r = await runInputOp(
            { kind: "read" },
            undefined,
            undefined,
            ok({ found: true, focused: true, nativeTag: 7, value: "hi", hasOnChangeText: true, ok: true })
        );
        expect(r).toMatchObject({ found: true, value: "hi", hasOnChangeText: true });
    });

    it("passes the not-found reason and candidates through", async () => {
        const r = await runInputOp(
            { kind: "read" },
            undefined,
            undefined,
            ok({ found: false, reason: "no focused TextInput", candidates: ["email"] })
        );
        expect(r).toEqual({ found: false, reason: "no focused TextInput", candidates: ["email"] });
    });

    it("reports executor failure as not-found rather than throwing", async () => {
        const r = await runInputOp({ kind: "read" }, undefined, undefined, async () => ({
            success: false,
            error: "No apps connected"
        }));
        expect(r).toEqual({ found: false, reason: "No apps connected" });
    });

    it("reports unparseable output as not-found rather than throwing", async () => {
        const r = await runInputOp({ kind: "read" }, undefined, undefined, async () => ({
            success: true,
            result: "not json"
        }));
        expect(r.found).toBe(false);
        if (!r.found) expect(r.reason).toContain("not json");
    });

    it("threads the device argument to the executor", async () => {
        const spy = jest.fn<ExecuteFn>(async () => ({
            success: true,
            result: JSON.stringify({ found: false, reason: "x" })
        }));
        await runInputOp({ kind: "read" }, undefined, "iPhone Air", spy);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "iPhone Air");
    });

    it("passes the query into the built expression", async () => {
        const spy = jest.fn<ExecuteFn>(async () => ({
            success: true,
            result: JSON.stringify({ found: false, reason: "x" })
        }));
        await runInputOp({ kind: "focus" }, { testID: "email-input" }, undefined, spy);
        expect(spy.mock.calls[0][0]).toContain("email-input");
    });
});
