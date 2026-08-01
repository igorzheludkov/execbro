import { describe, expect, it, jest } from "@jest/globals";
import { enterText, type TextEntryDeps } from "../../core/textEntry.js";
import type { InputOp, InputResult } from "../../core/inputTarget.js";

const found = (over: Partial<Extract<InputResult, { found: true }>> = {}): InputResult => ({
    found: true,
    focused: true,
    nativeTag: 1,
    value: null,
    hasOnChangeText: true,
    ok: true,
    ...over
});

function deps(results: InputResult[], over: Partial<TextEntryDeps> = {}): TextEntryDeps {
    const queue = [...results];
    return {
        runOp: jest.fn(async () => queue.shift() ?? found()),
        typeHid: jest.fn(async () => ({ success: true })),
        raise: jest.fn(async () => ({ raised: true, changed: false })),
        ...over
    };
}

const opsOf = (d: TextEntryDeps): string[] =>
    (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);

describe("enterText", () => {
    it("writes through onChangeText and verifies the exact string", async () => {
        const d = deps([found(), found({ value: "hello" }), found({ value: "hello" })]);
        const r = await enterText({ text: "hello" }, d);
        expect(r).toMatchObject({ success: true, value: "hello", path: "react", verified: true });
        expect(r.retried).toBeFalsy();
    });

    it("retries once on a mismatch and succeeds", async () => {
        // The reproduced corruption is a reorder: CASEB landed as CSEBA.
        const d = deps([
            found(),
            found({ value: "CASEB" }),
            found({ value: "CSEBA" }),
            found({ value: "" }),
            found({ value: "CASEB" }),
            found({ value: "CASEB" })
        ]);
        const r = await enterText({ text: "CASEB" }, d);
        expect(r).toMatchObject({ success: true, value: "CASEB", retried: true, verified: true });
    });

    it("fails hard when the mismatch survives the retry", async () => {
        const d = deps([
            found(),
            found({ value: "CASEB" }),
            found({ value: "CSEBA" }),
            found({ value: "" }),
            found({ value: "CASEB" }),
            found({ value: "CSEBA" })
        ]);
        const r = await enterText({ text: "CASEB" }, d);
        expect(r.success).toBe(false);
        expect(r.sent).toBe("CASEB");
        expect(r.landed).toBe("CSEBA");
        expect(r.verified).toBe(false);
    });

    it("never accepts a reorder as success", async () => {
        const d = deps([found(), found({ value: "CSEBA" }), found({ value: "CSEBA" })]);
        const r = await enterText({ text: "CASEB" }, d);
        // Same length, same characters, non-empty — every loose check passes it.
        expect(r.success).toBe(false);
    });

    it("refuses when nothing is focused and no target was given", async () => {
        const d = deps([{ found: false, reason: "no focused TextInput", candidates: [] }]);
        const r = await enterText({ text: "x" }, d);
        expect(r.success).toBe(false);
        expect(r.error).toContain("no focused TextInput");
    });

    it("passes ambiguity and candidates straight through", async () => {
        const candidates = [
            { index: 0, component: "FormInput", label: "Title *", placeholder: "Type here", value: "", testID: "t" },
            { index: 1, component: "FormInput", label: "Goal", placeholder: "Type here", value: "", testID: "g" }
        ];
        const d = deps([{ found: false, ambiguous: true, reason: "2 inputs match", candidates }]);
        const r = await enterText({ text: "x", textMatch: "Type here" }, d);
        expect(r.success).toBe(false);
        expect(r.ambiguous).toBe(true);
        expect(r.candidates).toEqual(candidates);
    });

    it("focuses the target itself when it is not already focused", async () => {
        const d = deps([
            found({ focused: false }),
            found({ focused: true }),
            found({ value: "a@b" }),
            found({ value: "a@b" })
        ]);
        await enterText({ text: "a@b", testID: "email" }, d);
        expect(opsOf(d)).toContain("focus");
    });

    it("does not re-focus a field that already has focus", async () => {
        const d = deps([found({ focused: true }), found({ value: "x" }), found({ value: "x" })]);
        await enterText({ text: "x" }, d);
        expect(opsOf(d)).not.toContain("focus");
    });

    it("appends by default", async () => {
        const d = deps([found({ value: "ab" }), found({ value: "abcd" }), found({ value: "abcd" })]);
        await enterText({ text: "cd" }, d);
        const setCall = (d.runOp as jest.Mock).mock.calls.find(
            (c) => (c[0] as InputOp).kind === "setValue"
        );
        expect((setCall![0] as { value: string }).value).toBe("abcd");
    });

    it("replaces when asked", async () => {
        const d = deps([found({ value: "ab" }), found({ value: "cd" }), found({ value: "cd" })]);
        await enterText({ text: "cd", replace: true }, d);
        const setCall = (d.runOp as jest.Mock).mock.calls.find(
            (c) => (c[0] as InputOp).kind === "setValue"
        );
        expect((setCall![0] as { value: string }).value).toBe("cd");
    });

    it("restores the previous value when a replace write fails", async () => {
        const d = deps([
            found({ value: "original" }),
            found({ ok: false, via: "no onChangeText (uncontrolled input)" }),
            found({ value: "original" })
        ]);
        const r = await enterText({ text: "new", replace: true }, d);
        expect(r.success).toBe(false);
        expect(r.error).toContain("restored");
        const written = (d.runOp as jest.Mock).mock.calls
            .filter((c) => (c[0] as InputOp).kind === "setValue")
            .map((c) => (c[0] as { value: string }).value);
        expect(written).toContain("original");
    });

    it("says so when the previous value could not be restored", async () => {
        const d = deps([
            found({ value: "original" }),
            found({ ok: false, via: "write failed" }),
            { found: false, reason: "gone" }
        ]);
        const r = await enterText({ text: "new", replace: true }, d);
        expect(r.error).toContain("COULD NOT be restored");
    });

    it("never lets a keyboard-raise failure fail the call", async () => {
        const d = deps([found(), found({ value: "hi" }), found({ value: "hi" })], {
            raise: jest.fn(async () => ({ raised: false, changed: false, reason: "osascript error 1002" }))
        });
        const r = await enterText({ text: "hi" }, d);
        expect(r.success).toBe(true);
        expect(r.keyboard).toMatchObject({ raised: false, reason: "osascript error 1002" });
    });

    it("raises the keyboard only after the text is in", async () => {
        const d = deps([found(), found({ value: "hi" }), found({ value: "hi" })]);
        await enterText({ text: "hi" }, d);
        expect(d.raise).toHaveBeenCalled();
        // Ordering matters: the raise is a convenience, never a precondition.
        const raiseOrder = (d.raise as jest.Mock).mock.invocationCallOrder[0];
        const lastOp = (d.runOp as jest.Mock).mock.invocationCallOrder.slice(-1)[0];
        expect(raiseOrder).toBeGreaterThan(lastOp);
    });

    it("falls back to HID and reports verified:false when no value can be read", async () => {
        const d = deps([
            found({ hasOnChangeText: false, value: null }),
            found({ hasOnChangeText: false, value: null })
        ]);
        const r = await enterText({ text: "hi" }, d);
        expect(r.path).toBe("hid");
        expect(r.verified).toBe(false);
        expect(r.error).toContain("could not be confirmed");
        expect(d.typeHid).toHaveBeenCalledWith("hi");
    });
});
