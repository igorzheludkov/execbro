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

/**
 * Compare the way a text field behaves, not the way a string does.
 *
 * Two things force this. A field applies its own transformations — RN defaults
 * `autoCapitalize` to "sentences", so typing "abc" legitimately yields "Abc" —
 * and strict equality reports that as corruption. And on iOS the accessibility
 * tree exposes AXValue but NO placeholder attribute (verified on device: an
 * empty field reports AXValue "Search" with AXLabel, title and
 * AXPlaceholderValue all null), so a read of an empty field is indistinguishable
 * from a read of one containing that word. Android has `hint` to subtract; iOS
 * has nothing.
 *
 * So the question asked is not "does the field equal what I predicted" — that
 * needs the prior text, which is exactly what cannot be read. It is "did the
 * characters I sent arrive intact", which needs only the sent string.
 */
function normalizeForCompare(s: string): string {
    return s.trim().toLowerCase();
}

export type TypedTextMatch = "exact" | "normalized" | "none";

export function matchTypedText(landed: string, expected: string, sent: string): TypedTextMatch {
    if (landed === expected || landed === sent) return "exact";
    const nLanded = normalizeForCompare(landed);
    const nSent = normalizeForCompare(sent);
    if (nLanded === normalizeForCompare(expected)) return "normalized";
    // The prior content is unknowable (see above), so an append is verified by
    // its tail. Empty sent text has no tail to prove anything with.
    if (nSent.length > 0 && nLanded.endsWith(nSent)) return "normalized";
    return "none";
}

export type TypedTextInput = {
    /** What the caller asked to type. */
    sent: string;
    /** What the field should hold afterwards — the prior text plus `sent`, unless replaced. */
    expected: string;
    /** What the field holds now; null when it could not be read. */
    landed: string | null;
    /** Why the read-back failed, when it did. */
    readError?: string;
    /** The field masks its contents, so no read-back can ever confirm them. */
    masked?: boolean;
    /**
     * Which field received the text (Android resource-id, iOS AXUniqueId —
     * both carry the testID). This path types into whatever the OS reports as
     * FOCUSED, which is not necessarily the field the caller last tapped: a
     * fiber tap on a TextInput fires its onPress without moving focus. Naming
     * the field turns that from a wrong-looking value into an obvious
     * mis-target. Verified on an Android emulator: a tap on password-input
     * left focus on nested-input, and the write reported "verified" against
     * the wrong field's contents.
     */
    fieldId?: string | null;
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
    const { sent, expected, landed, readError, masked, fieldId, nonLatinKeyboards } = input;
    const which = fieldId ? ` (${JSON.stringify(fieldId)})` : "";

    // A mask is not a failed read — it is a field that will never expose its
    // text to anyone. Say that once, plainly, instead of listing read-back
    // troubleshooting the caller cannot act on.
    if (masked === true) {
        return {
            status: "unverified",
            sent,
            message:
                `Typed ${JSON.stringify(sent)} into the masked field${which} (secureTextEntry) — delivered,` +
                ` but NOT` +
                ` verified: the accessibility tree exposes bullets, so no read-back can confirm the` +
                ` characters.` +
                keyboardNote(nonLatinKeyboards) +
                (nonLatinKeyboards.length > 0
                    ? ` A non-Latin active layout rewrites ASCII keystrokes silently, and a mask hides that.` +
                      ` ${REMEDY}`
                    : "")
        };
    }

    if (landed === null) {
        const why = readError ? `: ${readError}` : "";
        return {
            status: "unverified",
            sent,
            message:
                `Sent ${JSON.stringify(sent)} to the focused field${which} — NOT verified. It could not be` +
                ` read back${why}, so this is a report of what was sent, not of what the field received.` +
                keyboardNote(nonLatinKeyboards) +
                (nonLatinKeyboards.length > 0
                    ? ` A non-Latin active layout rewrites ASCII keystrokes silently. ${REMEDY}`
                    : "")
        };
    }

    const match = matchTypedText(landed, expected, sent);
    if (match !== "none") {
        const normalized =
            match === "normalized"
                ? " The field applied its own formatting (capitalization or trimming) — the characters" +
                  " sent arrived intact, so this is not a layout remap."
                : "";
        return {
            status: "verified",
            sent,
            landed,
            message:
                `Typed ${JSON.stringify(sent)} — verified: the focused field${which} now reads` +
                ` ${JSON.stringify(landed)}.` +
                normalized
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
            `Text did NOT land as sent. Sent ${JSON.stringify(sent)}, the focused field${which} now reads` +
            ` ${JSON.stringify(landed)}${expected !== sent ? ` (expected ${JSON.stringify(expected)})` : ""}.` +
            cause
    };
}
