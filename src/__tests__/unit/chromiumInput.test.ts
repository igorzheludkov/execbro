import { describe, it, expect } from "@jest/globals";
import { parseKeyCombo, wheelDelta, dragPath, scrollVerdict, MOD, type ScrollProbe } from "../../core/chromium.js";

function ok(input: string) {
    const r = parseKeyCombo(input);
    if ("error" in r) throw new Error(r.error);
    return r;
}

describe("parseKeyCombo", () => {
    it("Enter carries windowsVirtualKeyCode 13 and text, or it does not submit a form", () => {
        const r = ok("Enter");
        expect(r.mods).toBe(0);
        expect(r.key).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    });

    it("Shift+Tab sets the shift bit and sends no text", () => {
        const r = ok("Shift+Tab");
        expect(r.mods).toBe(MOD.Shift);
        expect(r.key).toMatchObject({ key: "Tab", windowsVirtualKeyCode: 9 });
        expect(r.key.text).toBeUndefined();
    });

    it("is case-insensitive and keeps no text under Meta, so the letter is not typed into the field", () => {
        const r = ok("meta+K");
        expect(r.mods).toBe(MOD.Meta);
        expect(r.key).toMatchObject({ key: "k", code: "KeyK", windowsVirtualKeyCode: 75 });
        expect(r.key.text).toBeUndefined();
    });

    it("a plain character types itself", () => {
        expect(ok("a").key).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
        expect(ok("7").key).toMatchObject({ key: "7", code: "Digit7", windowsVirtualKeyCode: 55, text: "7" });
    });

    it("Shift+a types the capital", () => {
        expect(ok("Shift+a").key.text).toBe("A");
    });

    it("accepts aliases and several modifiers", () => {
        const r = ok("Cmd+Shift+Esc");
        expect(r.mods).toBe(MOD.Meta | MOD.Shift);
        expect(r.key.key).toBe("Escape");
        expect(ok("ctrl+enter").mods).toBe(MOD.Control);
        expect(ok("Space").key).toMatchObject({ key: " ", code: "Space", text: " " });
        expect(ok("F12").key.windowsVirtualKeyCode).toBe(123);
    });

    it("a '+' key is reachable", () => {
        expect(ok("+").key.key).toBe("+");
        expect(ok("Shift++").mods).toBe(MOD.Shift);
    });

    it("an unknown key lists the valid names", () => {
        const r = parseKeyCombo("Hyper+Q");
        expect("error" in r && r.error).toMatch(/Hyper/);
        const u = parseKeyCombo("Launch");
        expect("error" in u && u.error).toMatch(/Enter.*Escape.*ArrowUp/s);
        expect("error" in parseKeyCombo("")).toBe(true);
        expect("error" in parseKeyCombo("Shift")).toBe(true);
    });
});

describe("wheelDelta", () => {
    const vp1 = { w: 1000, h: 800, dpr: 1 };
    it("up reveals content below: positive deltaY, 33% of the height by default", () => {
        expect(wheelDelta("up", undefined, vp1)).toEqual({ dx: 0, dy: 264 });
        expect(wheelDelta("down", undefined, vp1)).toEqual({ dx: 0, dy: -264 });
    });
    it("left reveals content to the right, like the finger moving right-to-left", () => {
        expect(wheelDelta("left", undefined, vp1)).toEqual({ dx: 330, dy: 0 });
        expect(wheelDelta("right", undefined, vp1)).toEqual({ dx: -330, dy: 0 });
    });
    it("distance is screenshot pixels, divided by pxPerCss at dpr 2", () => {
        expect(wheelDelta("up", 400, { w: 380, h: 600, dpr: 2 })).toEqual({ dx: 0, dy: 200 });
    });
    it("uses the downscaled factor past the cap (1440x900 @2 delivers 2000 wide)", () => {
        const k = 2000 / 1440;
        expect(wheelDelta("up", 500, { w: 1440, h: 900, dpr: 2 }).dy).toBeCloseTo(500 / k);
    });
});

describe("dragPath", () => {
    it("starts on start, ends exactly on end, at least 5 steps, monotonic in time and space", () => {
        const p = dragPath({ x: 10, y: 20 }, { x: 110, y: 20 }, 50);
        expect(p[0]).toEqual({ x: 10, y: 20, at: 0 });
        expect(p[p.length - 1]).toEqual({ x: 110, y: 20, at: 50 });
        expect(p.length).toBeGreaterThanOrEqual(6);
        for (let i = 1; i < p.length; i++) {
            expect(p[i].at).toBeGreaterThan(p[i - 1].at);
            expect(p[i].x).toBeGreaterThan(p[i - 1].x);
        }
    });
    it("is about 60 Hz", () => {
        expect(dragPath({ x: 0, y: 0 }, { x: 0, y: 100 }, 500).length).toBe(Math.round(500 / 16) + 1);
    });
});

describe("scrollVerdict", () => {
    const at = (top: number, left = 0, maxTop = 1000, maxLeft = 0): ScrollProbe => ({ container: "<div.list>", top, left, maxTop, maxLeft });
    it("reports the movement on the axis", () => {
        expect(scrollVerdict(at(0), at(264), { dx: 0, dy: 264 })).toEqual({ moved: 264 });
    });
    it("no container under the point", () => {
        expect(scrollVerdict({ container: null }, { container: null }, { dx: 0, dy: 100 }).warning).toMatch(/no scroll container/);
    });
    it("already at top", () => {
        expect(scrollVerdict(at(0), at(0), { dx: 0, dy: -100 }).warning).toMatch(/already at the top/);
    });
    it("already at end", () => {
        expect(scrollVerdict(at(1000), at(1000), { dx: 0, dy: 100 }).warning).toMatch(/already at the end/);
    });
    it("not scrollable on this axis", () => {
        expect(scrollVerdict(at(0), at(0), { dx: 100, dy: 0 }).warning).toMatch(/not scrollable horizontally/);
    });
    it("an inner list at its end hands the wheel to the page: that counts as scrolled, attributed to the page", () => {
        const inner = (pageTop: number): ScrollProbe => ({ container: "<div.list>", top: 1000, left: 0, maxTop: 1000, maxLeft: 0, page: { top: pageTop, left: 0 } });
        expect(scrollVerdict(inner(0), inner(264), { dx: 0, dy: 264 })).toEqual({ moved: 264, chainedTo: "the page" });
    });
    it("mid-scroll and did not move", () => {
        expect(scrollVerdict(at(500), at(500), { dx: 0, dy: 100 }).warning).toMatch(/did not move/);
    });
});
