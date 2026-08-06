/**
 * Deciding what a HID typing driver actually achieved.
 *
 * `axe`/`idb` type US-keyboard HID scancodes, but the characters that reach the
 * field are decided by the simulator's ACTIVE input layout. On a simulator set
 * to a Cyrillic layout, "envcheck@example.com" lands as "Ким Русь»учфьздуюсщь"
 * — pure ASCII in, non-Latin out. The driver reports success either way, so a
 * message echoing the REQUESTED string is not evidence of anything; only a
 * read-back of the field is.
 *
 * Hence: never confirm what was not read back, and when a mismatch is a script
 * change, say so — "landed differently" alone sends the reader hunting for a
 * bug in the app's validation, which is where the reported case lost its time.
 */

/** Ranges chosen to cover what an iOS keyboard layout can actually produce. */
const SCRIPTS: Array<{ name: string; re: RegExp }> = [
    { name: "Cyrillic", re: /[Ѐ-ӿԀ-ԯ]/ },
    { name: "Greek", re: /[Ͱ-Ͽἀ-῿]/ },
    { name: "Hebrew", re: /[֐-׿]/ },
    { name: "Arabic", re: /[؀-ۿݐ-ݿ]/ },
    { name: "Armenian", re: /[԰-֏]/ },
    { name: "Georgian", re: /[Ⴀ-ჿ]/ },
    { name: "Thai", re: /[฀-๿]/ },
    { name: "Devanagari", re: /[ऀ-ॿ]/ },
    { name: "Korean", re: /[ᄀ-ᇿ가-힯]/ },
    // Kana before the shared Han block: Japanese text is identified by its kana.
    { name: "Japanese", re: /[぀-ヿ]/ },
    { name: "Chinese", re: /[一-鿿]/ }
];

/**
 * The non-Latin script present in `text`, or null when it is plain ASCII.
 *
 * Deliberately reports a script found ANYWHERE in the string: a partial remap
 * (the first characters surviving, the rest not) is the shape that reads as a
 * truncation rather than as corruption.
 */
export function scriptOf(text: string): string | null {
    for (const s of SCRIPTS) {
        if (s.re.test(text)) return s.name;
    }
    return null;
}

export type TypedTextVerdict = {
    status: "verified" | "mismatch" | "unverified";
    message: string;
    sent: string;
    landed?: string;
};

export type TypedTextInput = {
    /** What the caller asked to type. */
    sent: string;
    /** What the field should hold afterwards — the prior text plus `sent`, unless replaced. */
    expected: string;
    /** What the field holds now; null when it could not be read. */
    landed: string | null;
    /** Why the read-back failed, when it did. */
    readError?: string;
    /** Non-Latin keyboards configured on this simulator, pre-formatted for display. */
    nonLatinKeyboards: string[];
};

const REMEDY =
    "Use input_text({ testID, text }) instead — it writes through React and is layout-independent" +
    " — or switch the simulator to a Latin keyboard layout before typing.";

function keyboardNote(nonLatinKeyboards: string[]): string {
    if (nonLatinKeyboards.length === 0) return "";
    return ` Non-Latin keyboards configured on this simulator: ${nonLatinKeyboards.join(", ")}.`;
}

export function verdictForTypedText(input: TypedTextInput): TypedTextVerdict {
    const { sent, expected, landed, readError, nonLatinKeyboards } = input;

    if (landed === null) {
        const why = readError ? `: ${readError}` : "";
        return {
            status: "unverified",
            sent,
            message:
                `Sent ${JSON.stringify(sent)} to the focused field — NOT verified. The field could not be` +
                ` read back${why}, so this is a report of what was sent, not of what the field received.` +
                keyboardNote(nonLatinKeyboards) +
                (nonLatinKeyboards.length > 0
                    ? ` A non-Latin active layout rewrites ASCII keystrokes silently. ${REMEDY}`
                    : "")
        };
    }

    if (landed === expected) {
        return {
            status: "verified",
            sent,
            landed,
            message: `Typed ${JSON.stringify(sent)} — verified: the field now reads ${JSON.stringify(landed)}.`
        };
    }

    const script = scriptOf(landed);
    const remapped = script !== null && scriptOf(sent) === null;
    const cause = remapped
        ? ` The keystrokes were re-mapped into ${script}, which is the simulator's active keyboard layout` +
          ` interpreting US-keyboard HID scancodes — the text sent was pure ASCII.` +
          keyboardNote(nonLatinKeyboards) +
          ` ${REMEDY}`
        : "";

    return {
        status: "mismatch",
        sent,
        landed,
        message:
            `Text did NOT land as sent. Sent ${JSON.stringify(sent)}, field now reads` +
            ` ${JSON.stringify(landed)}${expected !== sent ? ` (expected ${JSON.stringify(expected)})` : ""}.` +
            cause
    };
}
