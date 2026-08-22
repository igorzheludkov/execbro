import { describe, expect, it, jest } from "@jest/globals";
import { enterText, isHidTypeable, type TextEntryDeps } from "../../core/textEntry.js";
import type { InputOp, InputQuery, InputResult } from "../../core/inputTarget.js";

const found = (over: Partial<Extract<InputResult, { found: true }>> = {}): InputResult => ({
    found: true,
    focused: true,
    nativeTag: 1,
    value: null,
    testID: null,
    controlled: true,
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
        // No clear between attempts: setValue sets the whole value, so clearing
        // first is redundant (and on the native path, harmful).
        const d = deps([
            found(),
            found({ value: "CASEB" }),
            found({ value: "CSEBA" }),
            found({ value: "CASEB" }),
            found({ value: "CASEB" })
        ]);
        const r = await enterText({ text: "CASEB" }, d);
        expect(r).toMatchObject({ success: true, value: "CASEB", retried: true, verified: true });
        expect(opsOf(d)).not.toContain("clear");
    });

    it("fails hard when the mismatch survives the retry", async () => {
        const d = deps([
            found(),
            found({ value: "CASEB" }),
            found({ value: "CSEBA" }),
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

    // The screen can re-render between the resolve and the focus (a keyboard
    // raise is enough), so the second resolve misses where the first hit. That
    // path used to return the bare reason, leaving the caller with nothing to
    // re-target from — it then guessed again, which is the failure loop this
    // reproduces. Telemetry: 80% of "no TextInput matched" on 2.6.1 arrived
    // with no candidate list.
    it("keeps candidates when the target disappears between resolve and focus", async () => {
        const candidates = [
            { index: 0, component: "FormInput", label: "Email", placeholder: null, value: null, testID: "email" }
        ];
        const d = deps([
            found({ focused: false }),
            { found: false, reason: "no TextInput matched that target (1 input(s) mounted)", candidates, totalInputs: 1 }
        ]);
        const r = await enterText({ text: "x", testID: "email" }, d);
        expect(r.success).toBe(false);
        expect(r.error).toContain("no TextInput matched that target");
        expect(r.candidates).toEqual(candidates);
        expect(r.totalInputs).toBe(1);
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

    it("reports verified:false for an uncontrolled field with no accessibility read-back", async () => {
        // Without readNativeFields there is no way to see what landed, so the
        // write must be reported as unconfirmed rather than as a success.
        const d = deps([found({ controlled: false, hasOnChangeText: false, value: null })]);
        const r = await enterText({ text: "hi" }, d);
        expect(r.success).toBe(true);
        expect(r.verified).toBe(false);
        expect(r.error).toContain("uncontrolled");
    });

    it("uses setNativeProps for an uncontrolled field with NO handler", async () => {
        // Nothing to fire, so writing the native text directly is exact,
        // instant and Unicode-safe where HID is none of those.
        const d = deps([found({ controlled: false, hasOnChangeText: false, value: null })]);
        const r = await enterText({ text: "Привіт світ 世界" }, d);
        expect(r.path).toBe("native");
        expect(d.typeHid).not.toHaveBeenCalled();
        const ops = (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);
        expect(ops).toContain("setNative");
    });

    it("switches an uncontrolled+handler field to setNativeProps for non-ASCII", async () => {
        // HID has no keycode for these, so faithfulness is not on offer; the
        // resolver's setNative also fires onChangeText, so the app still gets it.
        for (const text of ["Привіт", "世界", "Señor", "aeñ"]) {
            const d = deps([found({ controlled: false, hasOnChangeText: true, value: null })]);
            const r = await enterText({ text }, d);
            expect(r.path).toBe("native");
            expect(d.typeHid).not.toHaveBeenCalled();
        }
    });

    it("keeps HID for plain ASCII, including symbols", async () => {
        const d = deps([found({ controlled: false, hasOnChangeText: true, value: null })]);
        const r = await enterText({ text: "a@b.com #1 {ok}" }, d);
        expect(r.path).toBe("hid");
    });

    it("keeps HID when an uncontrolled field HAS a handler", async () => {
        // setNativeProps would set the text without firing onChangeText, so the
        // field would show text the app never received.
        const d = deps([found({ controlled: false, hasOnChangeText: true, value: null })]);
        const r = await enterText({ text: "Alice" }, d);
        expect(r.path).toBe("hid");
        const ops = (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);
        expect(ops).not.toContain("setNative");
    });

    it("uses HID even when an uncontrolled field carries an onChangeText", async () => {
        // The test app's uncontrolled inputs pass `onChangeText={() => {}}`.
        // Branching on the handler would take the React path, call the no-op,
        // read back null, and report the text "landed differently than sent" —
        // reproduced on device before this branch keyed on `controlled`.
        const d = deps([found({ controlled: false, hasOnChangeText: true, value: null })]);
        const r = await enterText({ text: "Alice", testID: "name-input" }, d);
        expect(r.path).toBe("hid");
        expect(r.success).toBe(true);
        expect(r.verified).toBe(false);
        expect(d.typeHid).toHaveBeenCalledWith("Alice");
    });

    it("never reports an uncontrolled write as a mismatch", async () => {
        const d = deps([found({ controlled: false, hasOnChangeText: true, value: null })]);
        const r = await enterText({ text: "Alice" }, d);
        expect(r.sent).toBeUndefined();
        expect(r.landed).toBeUndefined();
    });
});

// A currency or similar masked field decorates the value it was given. The
// requested text IS in the field; reporting that as a failure sent the caller
// retrying a write that had already landed. 4 of the 5 mismatches on 2.6.1
// were exactly this ("10" -> "$10").
describe("fields that decorate the value they were given", () => {
    // A masked field reports its decorated value on every read, including the
    // one after the retry — so the read-back is fixed, not queued.
    const landing = (landed: string): TextEntryDeps => {
        let first = true;
        return deps([], {
            runOp: jest.fn(async () => {
                if (first) {
                    first = false;
                    return found();
                }
                return found({ value: landed });
            })
        });
    };

    it.each([
        ["10", "$10"],
        ["5.00", "$5.00"],
        ["55.55", "$55.55"],
        ["1.00", "$1.00"],
        ["1234", "1234%"]
    ])("accepts %s landing as %s", async (sent, landed) => {
        const r = await enterText({ text: sent }, landing(landed));
        expect(r.success).toBe(true);
        expect(r.value).toBe(landed);
        expect(r.error).toBeUndefined();
    });

    // The dangerous direction. A field that inserts a decimal turns 100 into
    // 1.00 — a different NUMBER, not a decoration. Stripping punctuation
    // wholesale would call that equal and report a false success, which is
    // strictly worse than the false failure being fixed here.
    it("still fails when interior punctuation changes the value", async () => {
        const r = await enterText({ text: "100" }, landing("1.00"));
        expect(r.success).toBe(false);
        expect(r.landed).toBe("1.00");
    });

    it("still fails on the HID reorder that motivated the exact comparison", async () => {
        const r = await enterText({ text: "CASEB" }, landing("CSEBA"));
        expect(r.success).toBe(false);
    });

    it("still fails when nothing landed", async () => {
        const r = await enterText({ text: "5.90" }, landing(""));
        expect(r.success).toBe(false);
    });
});

describe("isHidTypeable", () => {
    it("accepts printable ASCII", () => {
        expect(isHidTypeable("Alice in Wonderland")).toBe(true);
        expect(isHidTypeable("a@b.com !#$%^&*()_+-={}[]|\\:\";'<>?,./`~")).toBe(true);
        expect(isHidTypeable("")).toBe(true);
    });

    it("rejects Cyrillic, CJK and emoji", () => {
        expect(isHidTypeable("Привіт")).toBe(false);
        expect(isHidTypeable("世界")).toBe(false);
        expect(isHidTypeable("🎉")).toBe(false);
    });

    it("rejects Spanish accents, which look Latin but have no keycode", () => {
        // The easy one to miss: the text is otherwise ASCII.
        expect(isHidTypeable("Señor")).toBe(false);
        expect(isHidTypeable("á")).toBe(false);
        expect(isHidTypeable("über")).toBe(false);
    });
});

describe("append and replace on an uncontrolled field", () => {
    const nativeDeps = (fields: Array<{ id: string | null; text: string | null; focused: boolean }>) => ({
        readNativeFields: jest.fn(async () => ({ fields }))
    });

    it("reads the prior text from accessibility so append does not behave as replace", async () => {
        // target.value is always null for an uncontrolled field, so treating it
        // as "" made append overwrite — and the retry then cleared the field,
        // making the wrong answer verify clean.
        const d = deps([found({ controlled: false, hasOnChangeText: true, testID: "f", value: null })], {
            ...nativeDeps([{ id: "f", text: "abc", focused: true }])
        });
        await enterText({ text: "de", testID: "f" }, d);
        expect(d.typeHid).toHaveBeenCalledWith("de");
    });

    it("clears before an HID replace, since typing appends at the caret", async () => {
        const d = deps([found({ controlled: false, hasOnChangeText: true, testID: "f", value: null })], {
            ...nativeDeps([{ id: "f", text: "old", focused: true }])
        });
        await enterText({ text: "new", testID: "f", replace: true }, d);
        const ops = (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);
        expect(ops).toContain("clear");
        // After a clear the caret is at the start, so the full value is typed.
        expect(d.typeHid).toHaveBeenCalledWith("new");
    });

    it("does not clear when the field is already empty", async () => {
        // The read must reflect the write, or verification mismatches and the
        // retry clears — which would mask what this test is checking.
        let call = 0;
        const d = deps([found({ controlled: false, hasOnChangeText: true, testID: "f", value: null })], {
            readNativeFields: jest.fn(async () => ({
                fields: [{ id: "f", text: call++ === 0 ? "" : "new", focused: true }]
            }))
        });
        const r = await enterText({ text: "new", testID: "f", replace: true }, d);
        expect(r.verified).toBe(true);
        const ops = (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);
        expect(ops).not.toContain("clear");
    });
});

describe("retry clearing", () => {
    it("does not clear before retrying a native write", async () => {
        // publicInstance.clear() races the setNativeProps that follows it, which
        // made every non-ASCII retry land empty on a real device. The native
        // path sets the whole value, so the clear was redundant anyway.
        const d = deps([found({ controlled: false, hasOnChangeText: false, testID: "f", value: null })], {
            readNativeFields: jest.fn(async () => ({ fields: [{ id: "f", text: "stale", focused: true }] }))
        });
        await enterText({ text: "Привіт", testID: "f", replace: true }, d);
        const ops = (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);
        expect(ops).toContain("setNative");
        expect(ops).not.toContain("clear");
    });

    it("still clears before retrying an HID write, which appends", async () => {
        const d = deps([found({ controlled: false, hasOnChangeText: true, testID: "f", value: null })], {
            readNativeFields: jest.fn(async () => ({ fields: [{ id: "f", text: "stale", focused: true }] }))
        });
        await enterText({ text: "abc", testID: "f", replace: true }, d);
        const ops = (d.runOp as jest.Mock).mock.calls.map((c) => (c[0] as InputOp).kind);
        expect(ops).toContain("clear");
    });
});

describe("resolving through a screen transition", () => {
    const miss = (reason = "no TextInput matched that target (1 input(s) mounted)"): InputResult => ({
        found: false,
        reason,
        candidates: [],
        totalInputs: 1
    });

    it("re-resolves a targeted miss once before failing", async () => {
        // The field mounts a beat after the tool looked: the fiber tree still
        // held the screen being navigated away from.
        const d = deps([miss(), found(), found({ value: "hi" }), found({ value: "hi" })],
            { delay: jest.fn(async () => {}) });
        const r = await enterText({ text: "hi", testID: "message-text-input" }, d);
        expect(r.success).toBe(true);
        expect(opsOf(d).filter((k) => k === "find")).toHaveLength(2);
    });

    it("gives up after the one retry", async () => {
        const d = deps([miss(), miss()], { delay: jest.fn(async () => {}) });
        const r = await enterText({ text: "hi", testID: "message-text-input" }, d);
        expect(r.success).toBe(false);
        expect(opsOf(d).filter((k) => k === "find")).toHaveLength(2);
    });

    it("does not wait on an ambiguous match — waiting cannot resolve a choice", async () => {
        const d = deps([{ found: false, ambiguous: true, reason: "2 inputs match this target" }],
            { delay: jest.fn(async () => {}) });
        const r = await enterText({ text: "hi", testID: "message-text-input" }, d);
        expect(r.success).toBe(false);
        expect(opsOf(d).filter((k) => k === "find")).toHaveLength(1);
    });

    it("does not retry an untargeted call — nothing has focus now and waiting will not change that", async () => {
        const d = deps([miss("no focused TextInput. Pass testID")], { delay: jest.fn(async () => {}) });
        const r = await enterText({ text: "hi" }, d);
        expect(r.success).toBe(false);
        expect(opsOf(d).filter((k) => k === "find")).toHaveLength(1);
    });
});

/**
 * The pin, end to end.
 *
 * Live sequence 2026-08-22: set cents-input to "42.50" by testID, then
 * {textMatch:"42.50", text:"99.00", replace:true}. The field ended up holding
 * "99.00" and the tool reported "no TextInput matched that target" — because
 * every op after the resolve re-derived the field from a predicate that the
 * write itself had just destroyed. 83 of the 145 bad_target failures in 7 days
 * are that shape.
 */
describe("pinning the resolved field across the write", () => {
    // A miniature resolver: a field that answers to its current value or its
    // placeholder, and to its native tag. The value predicate stops matching
    // the instant a write lands, exactly as the real one does.
    const app = (startValue: string, tag: number | null = 42, placeholder = "Cents") => {
        let current = startValue;
        let writes = 0;
        const queries: (InputQuery | undefined)[] = [];
        const runOp = jest.fn(async (op: InputOp, q?: InputQuery): Promise<InputResult> => {
            queries.push(q);
            const byTag = tag !== null && q?.nativeTag === tag;
            const byText = q?.textMatch != null && (current.includes(q.textMatch) || placeholder.includes(q.textMatch));
            if (q !== undefined && !byTag && !byText) {
                return { found: false, reason: "no TextInput matched that target", candidates: [], totalInputs: 1 };
            }
            if (op.kind === "setValue" || op.kind === "setNative") {
                current = op.value;
                writes += 1;
            }
            if (op.kind === "clear") {
                current = "";
                writes += 1;
            }
            return found({ nativeTag: tag, value: current });
        });
        return { runOp: runOp as TextEntryDeps["runOp"], queries, writes: () => writes, value: () => current };
    };

    it("writes ONCE and verifies, where the same call used to report a targeting miss", async () => {
        const a = app("42.50");
        const d = deps([], { runOp: a.runOp });
        const r = await enterText({ text: "99.00", replace: true, textMatch: "42.50" }, d);

        expect(r).toMatchObject({ success: true, value: "99.00", verified: true });
        // The one assertion that matters: the double mutation is what damages a
        // user's app state, and a retry is a second write into a live field.
        expect(a.writes()).toBe(1);
        expect(r.retried).toBeFalsy();
        expect(a.value()).toBe("99.00");
    });

    it("carries the tag on every op after the resolve, and never on the resolve itself", async () => {
        const a = app("42.50");
        await enterText({ text: "99.00", replace: true, textMatch: "42.50" }, deps([], { runOp: a.runOp }));

        expect(a.queries[0]?.nativeTag).toBeUndefined();
        expect(a.queries.slice(1).length).toBeGreaterThan(0);
        expect(a.queries.slice(1).every((q) => q?.nativeTag === 42)).toBe(true);
    });

    it("reports UNVERIFIED rather than mutating twice when there is no tag to pin", async () => {
        // The field exposes no native tag, so the pin is unavailable and the
        // read-back re-resolves with the dead predicate. A miss there is
        // "unknown", not "empty" — the honest answer is an unverified success,
        // and crucially still ONE write.
        const a = app("42.50", null);
        const r = await enterText({ text: "99.00", replace: true, textMatch: "42.50" }, deps([], { runOp: a.runOp }));

        expect(r).toMatchObject({ success: true, verified: false });
        expect(r.error).toContain("could not be read back");
        expect(a.writes()).toBe(1);
        expect(a.value()).toBe("99.00");
    });

    it("leaves a placeholder-matched target behaving exactly as before", async () => {
        // A write does not invalidate a placeholder, so this path was never
        // broken and must not change.
        const a = app("42.50");
        const d = deps([], { runOp: a.runOp });
        const r = await enterText({ text: "99.00", replace: true, textMatch: "Cents" }, d);

        expect(r).toMatchObject({ success: true, value: "99.00", verified: true });
        expect(a.writes()).toBe(1);
        expect(r.retried).toBeFalsy();
    });
});
