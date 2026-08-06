/**
 * Type through a platform HID driver, then prove what landed.
 *
 * The driver's own success only means "scancodes were delivered". What the
 * field received depends on the simulator's active keyboard layout, on
 * autocorrect, on autoCapitalize — none of which the driver can see. So the
 * accessibility tree is read before and after, and the message this returns
 * describes the READ-BACK, never the request.
 *
 * Read-back failure is reported as unverified, never as success and never as a
 * mismatch: no evidence is not the same as evidence of corruption.
 */
import type { NativeField, NativeFieldsResult } from "./nativeInputValue.js";
import { verdictForTypedText, type TypedTextVerdict } from "./typedTextVerify.js";

export type HidTypeDeps = {
    /** Snapshot of the platform's text fields. */
    readFields: () => Promise<NativeFieldsResult>;
    /** Deliver the keystrokes. */
    type: (text: string) => Promise<{ success: boolean; error?: string }>;
    /** Clear the focused field first, for replace mode. */
    clear: () => Promise<{ success: boolean; error?: string }>;
    /** Non-Latin keyboards configured on the target, for diagnosis. */
    nonLatinKeyboards: () => Promise<string[]>;
    delay?: (ms: number) => Promise<void>;
};

export type HidTypeResult = {
    /** False only when the keystrokes could not be delivered, or landed wrong. */
    success: boolean;
    message: string;
    verdict?: TypedTextVerdict;
};

/**
 * The field a write landed in, with the text it held beforehand.
 *
 * iOS exposes no focus flag in its accessibility tree, so identity comes from
 * "exactly one field changed". Anything less certain returns null and the write
 * is reported unverified rather than compared against a guess.
 */
export function pickWrittenField(
    before: NativeField[],
    after: NativeField[]
): { previous: string; landed: string } | null {
    if (after.length === 0) return null;

    if (before.length === after.length) {
        const changed = after
            .map((f, i) => ({ i, f }))
            .filter(({ i, f }) => before[i].text !== f.text);
        if (changed.length === 1) {
            const { i, f } = changed[0];
            return { previous: before[i].text ?? "", landed: f.text ?? "" };
        }
        // Nothing changed at all: only meaningful when there is a single field,
        // where "unchanged" is still an answer about that field.
        if (changed.length === 0 && after.length === 1) {
            return { previous: before[0].text ?? "", landed: after[0].text ?? "" };
        }
        return null;
    }

    // The tree changed shape (a keyboard or an overlay mounted). One field is
    // still unambiguous; more than one is not.
    if (after.length === 1) {
        return { previous: before.length === 1 ? before[0].text ?? "" : "", landed: after[0].text ?? "" };
    }
    return null;
}

const SETTLE_MS = [0, 250, 500];

export async function typeAndVerify(
    text: string,
    opts: { replace?: boolean },
    deps: HidTypeDeps
): Promise<HidTypeResult> {
    const wait = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const beforeRead = await deps.readFields();

    if (opts.replace === true) {
        const cleared = await deps.clear();
        if (!cleared.success) {
            return {
                success: false,
                message: `nothing was typed — the field could not be cleared first: ${
                    cleared.error ?? "no focused TextInput"
                }`
            };
        }
    }

    const typed = await deps.type(text);
    if (!typed.success) {
        return { success: false, message: typed.error ?? "failed to input text" };
    }

    const keyboards = await deps.nonLatinKeyboards();
    // A replace cleared the field, so the prior text is gone from it either way.
    const previousAfterClear = (prev: string): string => (opts.replace === true ? "" : prev);

    let landed: string | null = null;
    let previous = "";
    let readError = beforeRead.error;

    for (const ms of SETTLE_MS) {
        if (ms > 0) await wait(ms);
        const after = await deps.readFields();
        if (after.error) {
            readError = after.error;
            continue;
        }
        const hit = pickWrittenField(beforeRead.fields, after.fields);
        if (!hit) {
            readError =
                after.fields.length === 0
                    ? "no text field is visible in the accessibility tree"
                    : "could not tell which field received the text (more than one changed)";
            continue;
        }
        readError = undefined;
        previous = hit.previous;
        landed = hit.landed;
        if (landed === previousAfterClear(previous) + text) break;
    }

    const verdict = verdictForTypedText({
        sent: text,
        expected: previousAfterClear(previous) + text,
        landed,
        readError,
        nonLatinKeyboards: keyboards
    });

    return { success: verdict.status !== "mismatch", message: verdict.message, verdict };
}
