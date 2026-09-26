import { describe, it, expect, afterEach } from "@jest/globals";
import { parseKeyCombo } from "../../core/chromium.js";
import { androidKeyFor } from "../../core/android.js";
import { hidKeyFor, iosKeyCombo } from "../../core/ios.js";

function combo(s: string) {
    const r = parseKeyCombo(s);
    if ("error" in r) throw new Error(r.error);
    return r;
}

describe("androidKeyFor", () => {
    it("maps named keys onto Android keycodes", () => {
        expect(androidKeyFor(combo("Enter"))).toEqual({ keycode: 66 });
        expect(androidKeyFor(combo("Tab"))).toEqual({ keycode: 61 });
        expect(androidKeyFor(combo("Backspace"))).toEqual({ keycode: 67 });
        expect(androidKeyFor(combo("Escape"))).toEqual({ keycode: 111 });
        expect(androidKeyFor(combo("Home"))).toEqual({ keycode: 122 });
        expect(androidKeyFor(combo("End"))).toEqual({ keycode: 123 });
        expect(androidKeyFor(combo("ArrowUp"))).toEqual({ keycode: 19 });
        expect(androidKeyFor(combo("ArrowRight"))).toEqual({ keycode: 22 });
        expect(androidKeyFor(combo("a"))).toEqual({ keycode: 29 });
        expect(androidKeyFor(combo("0"))).toEqual({ keycode: 7 });
    });
    it("refuses modifiers: adb input keyevent sends none", () => {
        const r = androidKeyFor(combo("Meta+K"));
        expect("error" in r && r.error).toMatch(/modifier/i);
    });
    it("refuses a character it has no keycode for", () => {
        expect("error" in androidKeyFor(combo("%"))).toBe(true);
    });
});

const hid = (s: string) => hidKeyFor(combo(s)) as { keycode: number; modifiers: number[] };

describe("hidKeyFor", () => {
    it("maps named keys and characters onto HID usage codes", () => {
        expect(hid("Enter")).toEqual({ keycode: 40, modifiers: [] });
        expect(hid("Escape").keycode).toBe(41);
        expect(hid("Backspace").keycode).toBe(42);
        expect(hid("Tab").keycode).toBe(43);
        expect(hid("Space").keycode).toBe(44);
        expect(hid("ArrowUp").keycode).toBe(82);
        expect(hid("F12").keycode).toBe(69);
        expect(hid("z").keycode).toBe(29);
        expect(hid("1").keycode).toBe(30);
        expect(hid("0").keycode).toBe(39);
    });
    it("refuses a character with no HID position here", () => {
        expect("error" in hidKeyFor(combo("%"))).toBe(true);
    });
    it("carries modifiers as HID codes", () => {
        expect(hid("Meta+Shift+a")).toEqual({ keycode: 4, modifiers: [225, 227] });
    });
});

describe("iosKeyCombo under IDB", () => {
    const saved = process.env.IOS_DRIVER;
    afterEach(() => { process.env.IOS_DRIVER = saved; });
    it("is refused with a message naming AXe, before any driver runs", async () => {
        process.env.IOS_DRIVER = "idb";
        const r = await iosKeyCombo([227], 4, "FAKE-UDID");
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/AXe/);
    });
});
