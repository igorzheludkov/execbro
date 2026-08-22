import type { InputCandidate, InputOp, InputQuery, InputResult } from "./inputTarget.js";
import type { RaiseResult } from "./keyboardRaise.js";
import { resolveWrittenField, type NativeField, type NativeFieldsResult } from "./nativeInputValue.js";
import {
    diagnoseStaleness,
    inputIdentity,
    recordScreen,
    type StalenessVerdict
} from "./screenStaleness.js";

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
    /**
     * True only when the landed text was read back and matched — exactly, or
     * modulo the field's own decoration, in which case `formatted` is set too.
     */
    verified?: boolean;
    /**
     * The field decorated the requested text (a currency symbol, a unit). The
     * write landed; `value` carries the field's rendering of it.
     */
    formatted?: boolean;
    retried?: boolean;
    keyboard?: RaiseResult;
    error?: string;
    sent?: string;
    landed?: string | null;
    ambiguous?: boolean;
    /** `candidates` holds what matched, not what is on screen. See InputMissing.matchedOnly. */
    matchedOnly?: boolean;
    candidates?: InputCandidate[];
    /** Total inputs mounted, so a capped candidate list cannot read as complete. */
    totalInputs?: number;
    /**
     * On a targeting miss: whether the screen moved under the agent. A miss
     * caused by someone using the app in parallel is not an input_text defect,
     * and must not be counted as one — see core/screenStaleness.ts.
     */
    staleness?: StalenessVerdict;
};

/**
 * The two axes an `input_text` outcome is reported on, and whether it is worth
 * a failure artifact.
 *
 * Separated from the tool handler because the interesting part is this
 * classification, not the plumbing around it — and because the three-way
 * `meaningful` (true / false / no opinion) is exactly the distinction that was
 * lost when everything went through one success boolean.
 */
export type TextEntryAxes = {
    /** A write was attempted. `meaningful` means nothing without this. */
    wrote: boolean;
    /**
     * Did the text verifiably land? `undefined` when nothing was written —
     * a call that never wrote has no opinion, which is NOT the same as "no".
     */
    meaningful?: boolean;
    /** Which artifact to capture, or null when there is nothing worth seeing. */
    artifactOutcome: "failure" | "unmeaningful" | null;
};

export function textEntryAxes(r: TextEntryResult): TextEntryAxes {
    // A write was attempted exactly when a path was chosen. `verified` is the
    // only positive evidence the text is in the field; everything else —
    // mismatch, unreadable field — is an unconfirmed or wrong write.
    const wrote = r.path !== undefined;

    const isTargetingMiss = !r.success && !wrote && r.candidates !== undefined;
    const isMismatch = !r.success && wrote;
    // The gap this closes: these reported success and were counted as clean.
    const isUnverified = r.success && wrote && r.verified !== true;

    return {
        wrote,
        ...(wrote && { meaningful: r.verified === true }),
        artifactOutcome: isUnverified
            ? "unmeaningful"
            : isTargetingMiss || isMismatch
                ? "failure"
                : null
    };
}

/**
 * How long a targeted resolve waits before its one retry. Long enough for a
 * stack push/pop to commit (RN's default screen transition is ~350ms), short
 * enough that a genuine miss still answers fast.
 */
const RESOLVE_SETTLE_MS = 500;

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
 * Whether `landed` is `sent` wearing the field's own decoration — a currency
 * symbol, a unit, a trailing percent — rather than a different value.
 *
 * ONLY leading and trailing non-alphanumerics are ignored. Interior
 * punctuation is load-bearing: a field that renders "100" as "1.00" holds a
 * different NUMBER, and stripping punctuation wholesale would report that as a
 * clean write. A false success there is strictly worse than the false failure
 * this exists to prevent, so the rule stays narrow — an interior change is
 * still a mismatch.
 */
export function isDecoratedValue(sent: string, landed: string | null): boolean {
    if (landed === null || sent.length === 0) return false;
    const bare = landed
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/[^\p{L}\p{N}]+$/u, "");
    return bare !== landed && bare === sent;
}

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

/**
 * Turns a resolver miss into a result, diagnosing whether the screen moved
 * under the agent on the way.
 *
 * The diagnosis is confined to "nothing matched". An ambiguous target or an
 * out-of-range index means the field WAS found — the agent simply has not
 * named one of several — and reporting those as interference would excuse a
 * targeting problem the agent can fix on its own.
 */
function missResult(miss: Extract<InputResult, { found: false }>, device?: string): TextEntryResult {
    const nothingMatched = !miss.ambiguous && !miss.matchedOnly;
    const staleness =
        nothingMatched && miss.candidates
            ? diagnoseStaleness(device, {
                elements: miss.candidates.map(inputIdentity),
                // A miss on an untargeted call IS the report that nothing has
                // focus, so this is knowable without another round-trip.
                focused: false
            })
            : undefined;

    return {
        success: false,
        error: staleness && staleness.kind !== "genuine_miss"
            ? `${miss.reason}\n  ${staleness.note}`
            : miss.reason,
        ...(miss.ambiguous && { ambiguous: true }),
        ...(miss.matchedOnly && { matchedOnly: true }),
        ...(miss.candidates && { candidates: miss.candidates }),
        ...(miss.totalInputs !== undefined && { totalInputs: miss.totalInputs }),
        ...(staleness && { staleness })
    };
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
    let target = await deps.runOp({ kind: "find" }, q, args.device);
    // A targeted miss taken DURING a screen transition is not a miss: the field
    // is a few hundred ms from mounting, and the fiber tree still holds the
    // screen being navigated away from. Telemetry 2026-08-10: four of the
    // thirteen captured failures were one flow typing into a chat composer
    // while the profile screen was still animating out, and the identical
    // predicate resolved when the agent retried by hand. One re-resolve buys
    // that whole class back. Only for a targeted query — an untargeted call
    // reports what has focus right now, and waiting cannot change that.
    if (!target.found && q && !target.ambiguous && !target.matchedOnly) {
        const wait = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        await wait(RESOLVE_SETTLE_MS);
        target = await deps.runOp({ kind: "find" }, q, args.device);
    }
    if (!target.found) return missResult(target, args.device);

    // Pin the field we just resolved, by native tag, for every operation that follows.
    //
    // A query is a DESCRIPTION and a write changes the thing being described. `textMatch` matching a field's value stops matching the instant the value is replaced, so the write, the read-back and the retry each re-resolved from scratch against a predicate the write itself had destroyed — and a landed write came back as "no TextInput matched that target". Telemetry 2026-08-22: 83 of the 145 bad_target failures in 7 days, the single largest bucket, all textMatch=<the value being replaced> with replace=true (5.99, 2.85, 10.00, 55534). Reproduced on the simulator: set cents-input to "42.50" by testID, then {textMatch:"42.50", text:"99.00", replace:true} — the field ends up holding "99.00" and the tool reports a targeting failure.
    //
    // InputQuery.nativeTag documents exactly this and has since it was added; wantTag was injected into the resolver and never read, and nothing ever set it. Both ends existed, the middle did not.
    //
    // The rest of the query is kept alongside the tag on purpose: the resolver falls back to it when the tag is gone, which is what a genuine remount looks like. Verified live 2026-08-22 on RN 0.85 with newArchEnabled: __eb_pub resolves to a ReactNativeElement whose __nativeTag is a real number, so the pin works on both architectures. A field that still yields no tag simply keeps today's behaviour.
    const opQuery: InputQuery | undefined =
        target.nativeTag != null ? { ...(q ?? {}), nativeTag: target.nativeTag } : q;

    // The resolve succeeded, so this is the last moment the screen is known to
    // have been in a state the agent could work with — the baseline the next
    // miss is judged against.
    if (target.allInputs) {
        recordScreen(args.device, {
            elements: target.allInputs.map(inputIdentity),
            focused: target.focused
        });
    }

    // 2. Focus it ourselves if needed. A tap reporting success does not
    //    guarantee React focus — reproduced on device.
    if (!target.focused) {
        const focused = await deps.runOp({ kind: "focus" }, opQuery, args.device);
        // Forward the candidate list exactly as the resolve path does. A
        // re-render between the two resolves (a keyboard raise is enough) makes
        // this miss where the first hit, and returning the bare reason leaves
        // the caller with nothing to re-target from — it guesses again, misses
        // again. On 2.6.1 that was 80% of all "no TextInput matched" errors.
        if (!focused.found) return missResult(focused, args.device);
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
            const r = await deps.runOp({ kind: "setValue", value: desired }, opQuery, args.device);
            return { path: "react", ok: r.found && r.ok, error: r.found ? r.via : r.reason };
        }
        if (target.hasOnChangeText && isHidTypeable(args.text)) {
            const r = await deps.typeHid(fromEmpty ? desired : args.text);
            return { path: "hid", ok: r.success, error: r.error };
        }
        const r = await deps.runOp({ kind: "setNative", value: desired }, opQuery, args.device);
        return { path: "native", ok: r.found && r.ok, error: r.found ? r.via : r.reason };
    };

    // `undefined` from readBack means "could not determine" and must surface as
    // unverified — never as a mismatch, which is what comparing against an
    // always-null read produced before.
    const readBack = async (): Promise<string | null | undefined> => {
        if (target.controlled) {
            const r = await deps.runOp({ kind: "read" }, opQuery, args.device);
            // A re-resolve that MISSES is "unknown", never "empty". Reading it as an empty field is what turned a landed write into a reported failure: the read-back re-resolves with the caller's original query, and a textMatch aimed at the value just overwritten cannot match any more, so this returned null, null compared unequal to the desired text, and the retry mutated the field a SECOND time. Telemetry 2026-08-22: 83 of the 145 bad_target failures in 7 days are that shape, all of them textMatch=<a value the call itself had just replaced>.
            // `undefined` routes it to the "could not be read back" path below, which is the honest answer. Independent of the pin: it holds wherever the field has no native tag to pin.
            return r.found ? r.value : undefined;
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
    if (needsClearFirst) await deps.runOp({ kind: "clear" }, opQuery, args.device);

    const first = await write(needsClearFirst);
    if (!first.ok) {
        // A failed replace already cleared the field. Put it back rather than
        // leaving the user's data destroyed with no mention of it.
        if (args.replace && target.hasOnChangeText && previous.length > 0) {
            const restored = await deps.runOp({ kind: "setValue", value: previous }, opQuery, args.device);
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
    // A decorated value is the write having landed, not having gone wrong, so
    // it must not burn the retry either — rewriting only makes the field
    // decorate it again.
    if (landed !== desired && !isDecoratedValue(desired, landed)) {
        retried = true;
        // Clear only for HID, which appends at the caret. The other paths set
        // the whole value, so a clear is redundant — and actively harmful:
        // publicInstance.clear() after HID typing races the setNativeProps that
        // follows and wipes it, which made every non-ASCII retry land empty.
        const clearedForRetry = first.path === "hid";
        if (clearedForRetry) {
            await deps.runOp({ kind: "clear" }, opQuery, args.device);
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

    // The field holds what it was asked to hold, plus its own formatting. The
    // exact comparison above is deliberately strict, but reporting this as a
    // failure sent callers retrying a write that had already landed.
    if (landed !== undefined && landed !== desired && isDecoratedValue(desired, landed)) {
        const keyboard = await deps.raise();
        return {
            success: true,
            value: landed ?? undefined,
            path: first.path,
            verified: true,
            formatted: true,
            ...(retried && { retried }),
            keyboard
        };
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
