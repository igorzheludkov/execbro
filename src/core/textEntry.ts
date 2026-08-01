import type { InputCandidate, InputOp, InputQuery, InputResult } from "./inputTarget.js";
import type { RaiseResult } from "./keyboardRaise.js";
import { resolveWrittenField, type NativeField, type NativeFieldsResult } from "./nativeInputValue.js";

export type EnterTextArgs = {
    /** The text to write. */
    text: string;
    testID?: string;
    component?: string;
    /** Matches value, placeholder, accessibilityLabel or the visible field label. */
    textMatch?: string;
    /** Choice among matches when a target is not unique. */
    index?: number;
    /** Replace the field's contents instead of appending. */
    replace?: boolean;
    device?: string;
};

/** How the text was written. See the branch in `write` for why each exists. */
export type WritePath = "react" | "hid" | "native";

export type TextEntryResult = {
    success: boolean;
    value?: string;
    path?: WritePath;
    /** True only when the landed text was read back and matched exactly. */
    verified?: boolean;
    retried?: boolean;
    keyboard?: RaiseResult;
    error?: string;
    sent?: string;
    landed?: string | null;
    ambiguous?: boolean;
    candidates?: InputCandidate[];
    /** Total inputs mounted, so a capped candidate list cannot read as complete. */
    totalInputs?: number;
};

export type TextEntryDeps = {
    runOp: (op: InputOp, query?: InputQuery, device?: string) => Promise<InputResult>;
    typeHid: (text: string) => Promise<{ success: boolean; error?: string }>;
    raise: () => Promise<RaiseResult>;
    /**
     * Reads the platform accessibility tree. Uncontrolled fields mirror nothing
     * into props, so this is the only way to verify a write into one.
     */
    readNativeFields?: () => Promise<NativeFieldsResult>;
    /** Injected so the native read-back's settle poll is testable without waiting. */
    delay?: (ms: number) => Promise<void>;
};

/**
 * Names the likely cause of a mismatch. The field's own keyboard settings
 * transform text on the way in, and "landed differently" alone sends the
 * reader hunting for a bug in the write when the write was fine.
 */
export function diagnoseMismatch(sent: string, landed: string | null): string {
    if (landed === null) return "";
    if (landed !== sent && landed.toLowerCase() === sent.toLowerCase()) {
        return " — only the capitalisation differs, which is the field's keyboard transforming input" +
            " (RN TextInput defaults autoCapitalize to 'sentences'); set autoCapitalize=\"none\" to type verbatim";
    }
    if (landed.replace(/\s+/g, "") === sent.replace(/\s+/g, "")) {
        return " — only whitespace differs, which is usually iOS smart punctuation or autocorrect spacing";
    }
    if (landed.length === sent.length && [...landed].sort().join("") === [...sent].sort().join("")) {
        return " — the same characters arrived in a different order, which is the HID keystroke race;" +
            " the retry already ran, so this one did not settle";
    }
    return "";
}

/**
 * Whether the HID driver can express this text at all.
 *
 * AXe types US-keyboard HID keycodes: A-Z, a-z, 0-9, space and the ASCII
 * symbols. Nothing outside that map has a keycode to send — which rules out
 * Cyrillic and CJK, and equally Spanish accents (á, ñ, ü), a case that is easy
 * to miss because the text otherwise looks Latin. `adb shell input text` is no
 * better: non-ASCII throws a NullPointerException inside InputShellCommand.
 */
export function isHidTypeable(text: string): boolean {
    // Printable ASCII plus tab/newline. Deliberately excludes the C1 range and
    // anything above 0x7E.
    return /^[\x20-\x7E\t\n]*$/.test(text);
}

function queryOf(a: EnterTextArgs): InputQuery | undefined {
    const q: InputQuery = {};
    if (a.testID != null) q.testID = a.testID;
    if (a.component != null) q.component = a.component;
    if (a.textMatch != null) q.textMatch = a.textMatch;
    if (a.index != null) q.index = a.index;
    return Object.keys(q).length > 0 ? q : undefined;
}

/**
 * Resolve -> focus -> write -> read back -> retry once -> raise keyboard.
 *
 * The read-back comparison is EXACT. The corruption reproduced on device is a
 * reorder (CASEB -> CSEBA), which every loose check — length, non-empty,
 * prefix — passes. A success from this function means the field holds the
 * requested string, or it says it could not confirm that.
 */
export async function enterText(args: EnterTextArgs, deps: TextEntryDeps): Promise<TextEntryResult> {
    const q = queryOf(args);

    // 1. Resolve. A miss is a hard failure — this is precisely where the old
    //    tools typed into the void and reported success.
    const target = await deps.runOp({ kind: "find" }, q, args.device);
    if (!target.found) {
        return {
            success: false,
            error: target.reason,
            ...(target.ambiguous && { ambiguous: true }),
            ...(target.candidates && { candidates: target.candidates }),
            ...(target.totalInputs !== undefined && { totalInputs: target.totalInputs })
        };
    }

    // 2. Focus it ourselves if needed. A tap reporting success does not
    //    guarantee React focus — reproduced on device.
    if (!target.focused) {
        const focused = await deps.runOp({ kind: "focus" }, q, args.device);
        if (!focused.found) return { success: false, error: focused.reason };
        if (!focused.ok) return { success: false, error: focused.via ?? "could not focus the input" };
    }

    // An uncontrolled field's current text is not in props, so `target.value` is
    // always null for one. Taking that as "" made append silently behave as
    // replace, and the retry then CLEARED the field to make the wrong answer
    // verify clean. The accessibility tree is the only place the real previous
    // text exists, so it has to be read before `desired` is computed.
    let nativeBefore: NativeField[] = [];
    const usesNativeReadBack = !target.controlled && deps.readNativeFields !== undefined;
    let previous = target.value ?? "";
    let previousKnown = target.controlled;
    if (usesNativeReadBack) {
        nativeBefore = (await deps.readNativeFields!()).fields;
        const current = resolveWrittenField(nativeBefore, nativeBefore, target.testID);
        if (current && current.text !== null) {
            previous = current.text;
            previousKnown = true;
        }
    }

    const desired = args.replace ? args.text : previous + args.text;

    // Three paths, chosen by what the field can actually honour:
    //
    //   controlled            -> onChangeText. The value prop mirrors the text,
    //                            so this both writes and stays verifiable.
    //   uncontrolled + handler, ASCII -> real keystrokes. The most faithful
    //                            simulation, and the retry now catches its
    //                            keystroke race, so the racy path is only taken
    //                            where it can actually succeed.
    //   uncontrolled + handler, non-ASCII -> setNativeProps AND a direct
    //                            onChangeText call. HID cannot express these
    //                            characters at all, so faithfulness is not on
    //                            offer; firing the handler is what keeps the
    //                            app from missing text the field displays.
    //   uncontrolled, no handler -> setNativeProps. Nothing to fire.
    // `fromEmpty` says whether the field was just cleared. It matters only for
    // HID, which appends at the caret rather than setting a value: typing the
    // delta into a populated field is right, but typing it into a cleared one
    // would lose whatever came before.
    const write = async (fromEmpty: boolean): Promise<{ path: WritePath; ok: boolean; error?: string }> => {
        if (target.controlled) {
            const r = await deps.runOp({ kind: "setValue", value: desired }, q, args.device);
            return { path: "react", ok: r.found && r.ok, error: r.found ? r.via : r.reason };
        }
        if (target.hasOnChangeText && isHidTypeable(args.text)) {
            const r = await deps.typeHid(fromEmpty ? desired : args.text);
            return { path: "hid", ok: r.success, error: r.error };
        }
        const r = await deps.runOp({ kind: "setNative", value: desired }, q, args.device);
        return { path: "native", ok: r.found && r.ok, error: r.found ? r.via : r.reason };
    };

    // `undefined` from readBack means "could not determine" and must surface as
    // unverified — never as a mismatch, which is what comparing against an
    // always-null read produced before.
    const readBack = async (): Promise<string | null | undefined> => {
        if (target.controlled) {
            const r = await deps.runOp({ kind: "read" }, q, args.device);
            return r.found ? r.value : null;
        }
        if (!usesNativeReadBack) return undefined;
        // A native write updates the view asynchronously, and the accessibility
        // dump is a separate process — reading immediately captures the state
        // from before the write. Poll until the text appears, then stop. Going
        // through MCP hid this because the call latency happened to cover it.
        const wait = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        let last: string | null | undefined;
        for (const ms of [0, 250, 500]) {
            if (ms > 0) await wait(ms);
            const after = await deps.readNativeFields!();
            if (after.error) {
                last = undefined;
                continue;
            }
            const hit = resolveWrittenField(nativeBefore, after.fields, target.testID);
            last = hit ? hit.text : undefined;
            if (last === desired) return last;
        }
        return last;
    };

    // HID appends at the caret, so a replace must clear first or it concatenates.
    const needsClearFirst =
        args.replace === true && !target.controlled && target.hasOnChangeText &&
        isHidTypeable(args.text) && previous.length > 0;
    if (needsClearFirst) await deps.runOp({ kind: "clear" }, q, args.device);

    const first = await write(needsClearFirst);
    if (!first.ok) {
        // A failed replace already cleared the field. Put it back rather than
        // leaving the user's data destroyed with no mention of it.
        if (args.replace && target.hasOnChangeText && previous.length > 0) {
            const restored = await deps.runOp({ kind: "setValue", value: previous }, q, args.device);
            return {
                success: false,
                path: first.path,
                error: `${first.error ?? "write failed"} (previous value ${
                    restored.found && restored.ok ? "restored" : "COULD NOT be restored"
                })`
            };
        }
        return { success: false, path: first.path, error: first.error ?? "write failed" };
    }

    let landed = await readBack();

    // Could not read the field at all — say so instead of guessing either way.
    if (landed === undefined) {
        const keyboard = await deps.raise();
        return {
            success: true,
            path: first.path,
            verified: false,
            keyboard,
            error: target.controlled
                ? "the value could not be read back"
                : "this field is uncontrolled and could not be located in the accessibility tree" +
                  (target.testID ? "" : " (it has no testID, and no single field's text changed)")
        };
    }

    let retried = false;
    if (landed !== desired) {
        retried = true;
        // Clear only for HID, which appends at the caret. The other paths set
        // the whole value, so a clear is redundant — and actively harmful:
        // publicInstance.clear() after HID typing races the setNativeProps that
        // follows and wipes it, which made every non-ASCII retry land empty.
        const clearedForRetry = first.path === "hid";
        if (clearedForRetry) {
            await deps.runOp({ kind: "clear" }, q, args.device);
        } else {
            // A native write immediately after another input operation is
            // sometimes swallowed — the value simply does not change. Give the
            // previous operation a beat to settle before rewriting, rather than
            // repeating the same call into the same contention.
            const wait = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
            await wait(300);
        }
        const second = await write(clearedForRetry);
        if (!second.ok) {
            return { success: false, path: second.path, retried, error: second.error ?? "rewrite failed" };
        }
        landed = await readBack();
    }

    if (landed !== desired) {
        // A read that failed only on the retry is still "unconfirmed", not a
        // mismatch — we have no evidence about what the field holds.
        if (landed === undefined) {
            const keyboard = await deps.raise();
            return {
                success: true, path: first.path, verified: false, retried, keyboard,
                error: "the rewrite could not be read back, so the result is unconfirmed"
            };
        }
        return {
            success: false,
            path: first.path,
            verified: false,
            retried,
            sent: desired,
            landed,
            error: `text landed differently than it was sent${diagnoseMismatch(desired, landed)}` +
                (!previousKnown && !args.replace
                    ? " — note the field's prior text could not be read, so the appended result was predicted from an empty starting point; pass replace:true to write an exact value"
                    : "")
        };
    }

    // Last, and never fatal.
    const keyboard = await deps.raise();
    return {
        success: true,
        value: landed,
        path: first.path,
        verified: true,
        ...(retried && { retried }),
        keyboard
    };
}
