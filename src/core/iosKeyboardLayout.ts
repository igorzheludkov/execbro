/**
 * Which keyboards a simulator has configured.
 *
 * A HID typing driver sends US-keyboard scancodes; the ACTIVE layout decides
 * what characters those become. iOS keeps no readable "currently active input
 * mode" in the device's preferences — only the configured set, in
 * `.GlobalPreferences.plist` under AppleKeyboards — so this cannot say which
 * layout is live. It says which ones COULD be, which is enough to explain a
 * read-back that came out in another script, and enough to warn when a
 * read-back was impossible.
 *
 * This never gates typing. It annotates a result the read-back already decided.
 */
import { execFileAsync } from "./exec.js";
import { homedir } from "node:os";
import { join } from "node:path";

export type SimKeyboard = {
    /** e.g. "uk_UA", or "emoji" for the emoji keyboard. */
    locale: string;
    /** The software layout name, e.g. "Ukrainian", "QWERTY-Spanish". */
    software: string | null;
    raw: string;
};

/**
 * Language subtags written in a non-Latin script. A US scancode typed under one
 * of these produces a character from that script, never the ASCII it names.
 */
const NON_LATIN_LANGUAGES = new Set([
    // Cyrillic
    "ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "tg", "tt", "ba", "cv", "ce",
    // Greek, Armenian, Georgian
    "el", "hy", "ka",
    // Hebrew / Arabic-script
    "he", "yi", "ar", "fa", "ur", "ps", "sd", "ku", "ug",
    // Indic and South-East Asian
    "hi", "bn", "pa", "gu", "or", "ta", "te", "kn", "ml", "si", "ne", "mr", "as", "sa",
    "th", "lo", "km", "my", "bo", "dv", "am", "ti",
    // CJK
    "zh", "ja", "ko"
]);

/** Parses `plutil -p` output for the AppleKeyboards array. */
export function parseAppleKeyboards(plutilOutput: string): SimKeyboard[] {
    const start = plutilOutput.indexOf('"AppleKeyboards" =>');
    if (start === -1) return [];
    const end = plutilOutput.indexOf("]", start);
    const block = plutilOutput.slice(start, end === -1 ? undefined : end);

    const out: SimKeyboard[] = [];
    // Entries look like: 2 => "uk_UA@sw=Ukrainian;hw=Automatic"
    const entry = /^\s*\d+\s*=>\s*"([^"]+)"\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = entry.exec(block)) !== null) {
        const raw = m[1];
        const [locale, rest] = raw.split("@");
        const sw = /(?:^|;)sw=([^;]*)/.exec(rest ?? "");
        out.push({ locale, software: sw ? sw[1] : null, raw });
    }
    return out;
}

export function isNonLatinKeyboard(k: SimKeyboard): boolean {
    // Emoji has no ASCII scancode mapping to corrupt — it is not a layout in
    // the sense that matters here, and flagging it would fire on most devices.
    if (k.locale === "emoji") return false;
    const lang = k.locale.split(/[_-]/)[0].toLowerCase();
    return NON_LATIN_LANGUAGES.has(lang);
}

/** The non-Latin keyboards, rendered for a warning message. */
export function formatKeyboards(keyboards: SimKeyboard[]): string[] {
    return keyboards
        .filter(isNonLatinKeyboard)
        .map((k) => (k.software ? `${k.locale} (${k.software})` : k.locale));
}

/**
 * Reads a simulator's configured keyboards. Best effort by contract: every
 * failure returns an empty list, because this only ever decorates a message.
 */
export async function readSimulatorKeyboards(udid: string): Promise<SimKeyboard[]> {
    const path = join(
        homedir(),
        "Library/Developer/CoreSimulator/Devices",
        udid,
        "data/Library/Preferences/.GlobalPreferences.plist"
    );
    try {
        const { stdout } = await execFileAsync("plutil", ["-p", path], { timeout: 5_000 });
        return parseAppleKeyboards(stdout);
    } catch {
        return [];
    }
}

/** The non-Latin keyboards configured on a simulator, ready to display. */
export async function nonLatinKeyboardsFor(udid?: string): Promise<string[]> {
    if (!udid) return [];
    return formatKeyboards(await readSimulatorKeyboards(udid));
}
