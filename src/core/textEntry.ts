import type { InputCandidate, InputOp, InputQuery, InputResult } from "./inputTarget.js";
import type { RaiseResult } from "./keyboardRaise.js";

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

export type TextEntryResult = {
    success: boolean;
    value?: string;
    path?: "react" | "hid";
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
};

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

    const previous = target.value ?? "";
    const desired = args.replace ? args.text : previous + args.text;

    const write = async (): Promise<{ path: "react" | "hid"; ok: boolean; error?: string }> => {
        if (target.hasOnChangeText) {
            const r = await deps.runOp({ kind: "setValue", value: desired }, q, args.device);
            return { path: "react", ok: r.found && r.ok, error: r.found ? r.via : r.reason };
        }
        const r = await deps.typeHid(args.text);
        return { path: "hid", ok: r.success, error: r.error };
    };

    const readBack = async (): Promise<string | null> => {
        const r = await deps.runOp({ kind: "read" }, q, args.device);
        return r.found ? r.value : null;
    };

    const first = await write();
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

    // An uncontrolled input exposes no value to read. Say so rather than
    // claiming a success we did not confirm.
    if (landed === null && !target.hasOnChangeText) {
        const keyboard = await deps.raise();
        return {
            success: true,
            path: first.path,
            verified: false,
            keyboard,
            error: "the field exposes no readable value, so the text could not be confirmed"
        };
    }

    let retried = false;
    if (landed !== desired) {
        retried = true;
        await deps.runOp({ kind: "clear" }, q, args.device);
        const second = await write();
        if (!second.ok) {
            return { success: false, path: second.path, retried, error: second.error ?? "rewrite failed" };
        }
        landed = await readBack();
    }

    if (landed !== desired) {
        return {
            success: false,
            path: first.path,
            verified: false,
            retried,
            sent: desired,
            landed,
            error: "text landed differently than it was sent"
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
