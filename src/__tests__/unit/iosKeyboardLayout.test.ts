import { describe, expect, it } from "@jest/globals";
import { formatKeyboards, isNonLatinKeyboard, parseAppleKeyboards } from "../../core/iosKeyboardLayout.js";

// Verbatim `plutil -p` output from the simulator that produced issue #14.
const PLIST = `{
  "AKLastLocale" => "en_UA"
  "AppleKeyboards" => [
    0 => "de_DE@sw=QWERTZ-German;hw=Automatic"
    1 => "es_ES@sw=QWERTY-Spanish;hw=Automatic"
    2 => "uk_UA@sw=Ukrainian;hw=Automatic"
    3 => "en_GB@sw=QWERTY;hw=Automatic"
    4 => "en_US@sw=QWERTY;hw=Automatic"
    5 => "emoji@sw=Emoji"
    6 => "he_IL@sw=Hebrew;hw=Automatic"
  ]
  "AppleKeyboardsExpanded" => 1
  "AppleLocale" => "en_UA"
}`;

describe("parseAppleKeyboards", () => {
    it("reads every configured keyboard out of plutil output", () => {
        const k = parseAppleKeyboards(PLIST);
        expect(k.map((e) => e.locale)).toEqual([
            "de_DE",
            "es_ES",
            "uk_UA",
            "en_GB",
            "en_US",
            "emoji",
            "he_IL"
        ]);
        expect(k[2]).toMatchObject({ locale: "uk_UA", software: "Ukrainian" });
    });

    it("returns nothing when the key is absent, rather than guessing", () => {
        expect(parseAppleKeyboards(`{\n  "AppleLocale" => "en_US"\n}`)).toEqual([]);
    });

    it("stops at the end of the AppleKeyboards array", () => {
        const k = parseAppleKeyboards(PLIST);
        expect(k.some((e) => e.locale.includes("Expanded"))).toBe(false);
    });
});

describe("isNonLatinKeyboard", () => {
    it("flags layouts that cannot produce ASCII from US scancodes", () => {
        expect(isNonLatinKeyboard({ locale: "uk_UA", software: "Ukrainian", raw: "" })).toBe(true);
        expect(isNonLatinKeyboard({ locale: "he_IL", software: "Hebrew", raw: "" })).toBe(true);
        expect(isNonLatinKeyboard({ locale: "ru_RU", software: "Russian", raw: "" })).toBe(true);
        expect(isNonLatinKeyboard({ locale: "ja_JP", software: "Kana", raw: "" })).toBe(true);
    });

    it("does not flag Latin layouts, including accented ones", () => {
        expect(isNonLatinKeyboard({ locale: "en_US", software: "QWERTY", raw: "" })).toBe(false);
        expect(isNonLatinKeyboard({ locale: "de_DE", software: "QWERTZ-German", raw: "" })).toBe(false);
        expect(isNonLatinKeyboard({ locale: "es_ES", software: "QWERTY-Spanish", raw: "" })).toBe(false);
    });

    it("does not flag the emoji keyboard — it sends no ASCII scancodes at all", () => {
        expect(isNonLatinKeyboard({ locale: "emoji", software: "Emoji", raw: "" })).toBe(false);
    });
});

describe("formatKeyboards", () => {
    it("lists only the non-Latin ones, named the way the simulator names them", () => {
        expect(formatKeyboards(parseAppleKeyboards(PLIST))).toEqual([
            "uk_UA (Ukrainian)",
            "he_IL (Hebrew)"
        ]);
    });
});
