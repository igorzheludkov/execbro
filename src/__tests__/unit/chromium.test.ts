import { describe, it, expect } from "@jest/globals";
import { pxPerCss, CHROMIUM_MAX_DIMENSION, pickDomTarget, normText, buildDomCollectJs, buildDomPrepareJs, type DomCandidate } from "../../core/chromium.js";

describe("pxPerCss", () => {
    it("is devicePixelRatio when the raw capture fits the cap (FluentTalk popover, 380x600 @2)", () => {
        expect(pxPerCss({ w: 380, h: 600, dpr: 2 })).toBe(2);
    });

    it("is 1 on a non-retina window under the cap", () => {
        expect(pxPerCss({ w: 1280, h: 800, dpr: 1 })).toBe(1);
    });

    it("drops below dpr so the longest side lands exactly on the cap (1440x900 @2 = 2880 raw)", () => {
        const k = pxPerCss({ w: 1440, h: 900, dpr: 2 });
        expect(k).toBeCloseTo(CHROMIUM_MAX_DIMENSION / 1440);
        expect(Math.round(1440 * k)).toBe(CHROMIUM_MAX_DIMENSION);
    });

    it("uses the longest side for a portrait window", () => {
        expect(Math.round(1200 * pxPerCss({ w: 700, h: 1200, dpr: 2 }))).toBe(CHROMIUM_MAX_DIMENSION);
    });

    it("round-trips a delivered pixel to CSS and back within half a pixel", () => {
        const vp = { w: 1440, h: 900, dpr: 2 };
        const k = pxPerCss(vp);
        const px = { x: 1234, y: 567 };
        const css = { x: px.x / k, y: px.y / k };
        expect(Math.abs(Math.round(css.x * k) - px.x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(Math.round(css.y * k) - px.y)).toBeLessThanOrEqual(0.5);
    });
});

const cand = (i: number, text: string, extra: Partial<DomCandidate> = {}): DomCandidate => ({
    i, tag: "button", text, testID: null, label: null, placeholder: null, value: null,
    rect: { x: 0, y: 0, w: 10, h: 10 }, ...extra,
});

describe("pickDomTarget", () => {
    it("prefers an exact text match over case-insensitive and substring matches", () => {
        const cs = [cand(0, "Save draft"), cand(1, "save"), cand(2, "Save")];
        expect(pickDomTarget(cs, "Save", undefined)).toEqual({ kind: "ok", cand: cs[2] });
    });

    it("falls back to case-insensitive exact, then to substring", () => {
        expect(pickDomTarget([cand(0, "Save draft"), cand(1, "SAVE")], "save", undefined)).toEqual({ kind: "ok", cand: cand(1, "SAVE") });
        expect(pickDomTarget([cand(0, "Save draft")], "save", undefined)).toEqual({ kind: "ok", cand: cand(0, "Save draft") });
    });

    it("compares whitespace-collapsed text", () => {
        expect(pickDomTarget([cand(0, "Sign in")], "  Sign   in ", undefined).kind).toBe("ok");
    });

    it("refuses to guess between several equally good matches", () => {
        const cs = [cand(0, "Copy"), cand(1, "Copy")];
        expect(pickDomTarget(cs, "Copy", undefined)).toEqual({ kind: "ambiguous", matches: cs });
    });

    it("index picks within the winning tier; out of range is none", () => {
        const cs = [cand(0, "Copy"), cand(1, "Copy"), cand(2, "Copy link")];
        expect(pickDomTarget(cs, "Copy", 1)).toEqual({ kind: "ok", cand: cs[1] });
        expect(pickDomTarget(cs, "Copy", 5)).toEqual({ kind: "none" });
    });

    it("with no text (testID / component), every candidate is equally good", () => {
        expect(pickDomTarget([cand(0, "")], undefined, undefined).kind).toBe("ok");
        expect(pickDomTarget([cand(0, ""), cand(1, "")], undefined, undefined).kind).toBe("ambiguous");
        expect(pickDomTarget([], undefined, undefined)).toEqual({ kind: "none" });
    });
});

describe("normText", () => {
    it("collapses runs of whitespace, including newlines", () => {
        expect(normText("  a \n\t b  ")).toBe("a b");
    });
});

describe("injected DOM scripts are valid JavaScript", () => {
    const parses = (js: string) => () => new Function(`return ${js};`);
    it.each([
        ["tap/testID", { mode: "tap", testID: "save-btn" }],
        ["tap/text with quotes", { mode: "tap", text: "Don't \"stop\"" }],
        ["tap/component", { mode: "tap", component: "SpeakButton" }],
        ["input/textMatch", { mode: "input", textMatch: "Email" }],
        ["input/untargeted", { mode: "input" }],
    ] as const)("collector: %s", (_n, q) => {
        expect(parses(buildDomCollectJs(q))).not.toThrow();
    });
    it("prepare", () => expect(parses(buildDomPrepareJs(3))).not.toThrow());
});
