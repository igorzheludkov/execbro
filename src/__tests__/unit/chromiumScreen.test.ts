import { describe, it, expect } from "@jest/globals";
import { DOM_HELPERS_JS, buildScreenCollectJs, rawToScreenState, buildLayoutCollectJs, formatChromiumLayout, buildInspectJs, formatChromiumInspect, formatChromiumMeasure, type RawScreen, type RawLayout, type RawInspect } from "../../core/chromiumScreen.js";
import { formatScreenStateSummary } from "../../core/screenState.js";

// Pull one injected helper out as a callable, with the browser globals it reads.
function helper<T>(name: string, globals: Record<string, unknown> = {}): T {
    const keys = Object.keys(globals);
    return new Function(...keys, `${DOM_HELPERS_JS}; return ${name};`)(...keys.map((k) => globals[k])) as T;
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (x: number, y: number, w: number, h: number): Box => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });

describe("safeValue", () => {
    const safeValue = helper<(el: unknown) => string | null>("safeValue");
    it("never returns a password", () => {
        expect(safeValue({ type: "password", value: "hunter2" })).toBe("[password]");
        expect(safeValue({ type: "PASSWORD", value: "" })).toBe("");
    });
    it("returns other values and contenteditable text", () => {
        expect(safeValue({ type: "text", value: "vote" })).toBe("vote");
        expect(safeValue({ isContentEditable: true, innerText: "hi" })).toBe("hi");
        expect(safeValue({ tagName: "DIV" })).toBeNull();
    });
});

describe("labelOf", () => {
    const labelOf = helper<(el: unknown) => string | null>("labelOf");
    const attrs = (a: Record<string, string> = {}) => (n: string) => a[n] ?? null;
    it("names a select by its selected option, not by a wrapping label's text of every option", () => {
        const select = {
            tagName: "SELECT", getAttribute: attrs(), selectedIndex: 1,
            options: [{ text: "Choose…" }, { text: "English" }],
            labels: [{ innerText: "Native Choose… English Ukrainian" }],
        };
        expect(labelOf(select)).toBe("English");
    });
    it("prefers aria-label, then the field's label", () => {
        expect(labelOf({ tagName: "BUTTON", getAttribute: attrs({ "aria-label": "Speak" }), innerText: "🔊" })).toBe("Speak");
        expect(labelOf({ tagName: "INPUT", type: "checkbox", getAttribute: attrs(), labels: [{ innerText: "Keep open (debug)" }] })).toBe("Keep open (debug)");
    });
});

describe("visibleRect", () => {
    const doc = { body: {}, documentElement: {} };
    const styles = new Map<unknown, { overflowX: string; overflowY: string }>();
    const visibleRect = helper<(el: unknown, b?: Box) => unknown>("visibleRect", {
        document: doc,
        innerWidth: 400,
        innerHeight: 600,
        getComputedStyle: (el: unknown) => styles.get(el) ?? { overflowX: "visible", overflowY: "visible" },
    });
    const scroller = { getBoundingClientRect: () => box(0, 100, 400, 300), parentElement: doc.body };
    styles.set(scroller, { overflowX: "hidden", overflowY: "auto" });
    const inList = (y: number) => ({ getBoundingClientRect: () => box(0, y, 400, 40), parentElement: scroller });

    it("is null for an element that is not rendered", () => {
        expect(visibleRect({ getBoundingClientRect: () => box(0, 0, 0, 0), parentElement: doc.body })).toBeNull();
    });
    it("is 'off' for a row scrolled out of its overflow container, though inside the viewport", () => {
        expect(visibleRect(inList(20))).toBe("off");
        expect(visibleRect(inList(450))).toBe("off");
    });
    it("clips a partly visible row to the container, so its centre is on screen", () => {
        expect(visibleRect(inList(380))).toEqual({ x: 0, y: 380, w: 400, h: 20 });
    });
    it("clips to the viewport", () => {
        expect(visibleRect({ getBoundingClientRect: () => box(-50, 580, 100, 40), parentElement: doc.body })).toEqual({ x: 0, y: 580, w: 50, h: 20 });
    });
    it("honours checkVisibility when the browser has it", () => {
        expect(visibleRect({ getBoundingClientRect: () => box(0, 0, 10, 10), parentElement: doc.body, checkVisibility: () => false })).toBeNull();
    });
});

describe("leafPresses", () => {
    const leafPresses = helper<(els: unknown[]) => unknown[]>("leafPresses");
    const node = (kids: unknown[] = []) => {
        const n = { kids, contains: (o: unknown): boolean => n === o || kids.some((k) => k === o || (k as { contains(o: unknown): boolean }).contains(o)) };
        return n;
    };
    it("keeps only pressables with no pressable inside, so a click-wrapper does not own the text under it", () => {
        const button = node();
        const backdrop = node([node([button])]);
        const card = node();
        expect(leafPresses([backdrop, button, card])).toEqual([button, card]);
    });
});

describe("nameOf", () => {
    const nameOf = helper<(t: unknown) => string | null>("nameOf");
    it("names functions, memo and forwardRef wrappers, and skips host strings", () => {
        function Card() {}
        expect(nameOf(Card)).toBe("Card");
        expect(nameOf({ $$typeof: "memo", type: Card })).toBe("Card");
        expect(nameOf({ render: function Row() {} })).toBe("Row");
        expect(nameOf({ displayName: "Named" })).toBe("Named");
        expect(nameOf("div")).toBeNull();
        expect(nameOf(null)).toBeNull();
    });
});

describe("buildScreenCollectJs", () => {
    it("parses", () => {
        expect(() => new Function(`return ${buildScreenCollectJs()};`)).not.toThrow();
    });
});

const raw = (over: Partial<RawScreen> = {}): RawScreen => ({
    viewport: { w: 380, h: 600, dpr: 2 },
    url: "http://localhost:5173/popover.html?lang=uk#/recent",
    title: "FluentTalk",
    overlays: [],
    nodes: [],
    offscreen: 0,
    dropped: 0,
    ...over,
});

describe("rawToScreenState", () => {
    it("converts CSS px to delivered px with pxPerCss (dpr 2)", () => {
        const ss = rawToScreenState(raw({
            nodes: [{ kind: "press", rect: { x: 10, y: 20, w: 100, h: 30 }, overlay: null, covered: false, label: "Speak", component: "SpeakButton", testID: null }],
        }));
        expect(ss.pressables[0]).toMatchObject({ center: { x: 120, y: 70 }, bounds: { x: 20, y: 40, width: 200, height: 60 }, label: "Speak", component: "SpeakButton" });
    });

    it("lowers the factor past the 2000 px cap, matching the screenshot", () => {
        const ss = rawToScreenState(raw({
            viewport: { w: 1100, h: 612, dpr: 2 },
            nodes: [{ kind: "text", rect: { x: 1000, y: 0, w: 100, h: 10 }, overlay: null, covered: false, text: "end" }],
        }));
        // pxPerCss = 2000 / 1100
        expect(ss.texts[0].bounds).toEqual({ x: 1818, y: 0, width: 182, height: 18 });
    });

    it("uses the page location as the route", () => {
        const ss = rawToScreenState(raw());
        expect(ss.route).toEqual({ name: "/popover.html#/recent", params: { lang: "uk" }, stack: ["/popover.html#/recent"] });
        expect(ss.notes?.join("\n")).toContain('"FluentTalk"');
    });

    it("does not print a data: URL's whole document as the route", () => {
        const ss = rawToScreenState(raw({ url: "data:text/html," + "%3Ch1%3EHello%3C%2Fh1%3E".repeat(20) }));
        expect(ss.route?.name).toBe("(data: URL)");
    });

    it("puts overlay content in its overlay and covered elements under Blocked", () => {
        const ss = rawToScreenState(raw({
            overlays: [{ type: "Unknown", title: "<div#eb-cover>" }],
            nodes: [
                { kind: "press", rect: { x: 0, y: 0, w: 50, h: 20 }, overlay: 0, covered: false, label: "Close", component: null, testID: "close" },
                { kind: "press", rect: { x: 0, y: 100, w: 50, h: 20 }, overlay: 0, covered: true, label: "Saved Words", component: null, testID: null },
            ],
        }));
        expect(ss.overlays[0].pressables.map((p) => p.label)).toEqual(["Close"]);
        expect(ss.pressables[0]).toMatchObject({ label: "Saved Words", blockedByOverlay: true });
        const out = formatScreenStateSummary(ss);
        expect(out).toContain('🔲 Unknown — "<div#eb-cover>"');
        expect(out).toContain("🚫 Blocked by overlay");
        expect(out).toMatch(/🚫[\s\S]*"Saved Words"/);
    });

    it("renders inputs and checkboxes through the shared formatter", () => {
        const out = formatScreenStateSummary(rawToScreenState(raw({
            viewport: { w: 400, h: 600, dpr: 1 },
            nodes: [
                { kind: "press", rect: { x: 0, y: 0, w: 200, h: 30 }, overlay: null, covered: false, label: null, component: "MainApp", testID: null, input: { value: null, placeholder: "Search" } },
                { kind: "press", rect: { x: 0, y: 50, w: 20, h: 20 }, overlay: null, covered: false, label: "Keep open (debug)", component: null, testID: null, checked: true },
            ],
        })));
        expect(out).toContain('[input] empty, placeholder:"Search"');
        expect(out).toContain("[switch:ON]");
    });

    it("says when the window is hidden, and counts off-screen and dropped elements", () => {
        const notes = rawToScreenState(raw({ viewport: { w: 380, h: 600, dpr: 1, hidden: true }, offscreen: 7, dropped: 3 })).notes!.join("\n");
        expect(notes).toContain("hidden");
        expect(notes).toContain("7 more");
        expect(notes).toContain("3 element(s) past");
    });
});

const layout = (nodes: RawLayout["nodes"], over: Partial<RawLayout> = {}): RawLayout =>
    ({ viewport: { w: 380, h: 600, dpr: 2 }, nodes, offscreen: 0, dropped: 0, ...over });

describe("formatChromiumLayout", () => {
    it("indents by component depth, in delivered px", () => {
        const out = formatChromiumLayout(layout([
            { depth: 0, name: "PopoverApp", rect: { x: 0, y: 0, w: 380, h: 600 } },
            { depth: 1, name: "SpeakButton", rect: { x: 10, y: 20, w: 30, h: 30 }, testID: "speak" },
        ]), false);
        expect(out).toContain("PopoverApp (0,0 760x1200)");
        expect(out).toContain('  SpeakButton (20,40 60x60) testID="speak"');
    });
    it("prints a text once, on the deepest component that carries it", () => {
        const out = formatChromiumLayout(layout([
            { depth: 0, name: "Row", rect: { x: 0, y: 0, w: 10, h: 10 }, text: "vote" },
            { depth: 1, name: "Label", rect: { x: 0, y: 0, w: 10, h: 10 }, text: "vote" },
        ]), false);
        expect(out.match(/"vote"/g)).toHaveLength(1);
        expect(out).toContain('  Label (0,0 20x20) "vote"');
    });
    it("prints extended styles inline", () => {
        const out = formatChromiumLayout(layout([{ depth: 0, name: "A", rect: { x: 0, y: 0, w: 1, h: 1 }, style: { display: "flex", gap: "8px" } }]), false);
        expect(out).toContain("{display: flex, gap: 8px}");
    });
    it("summary counts components by name", () => {
        const out = formatChromiumLayout(layout([
            { depth: 0, name: "Row", rect: { x: 0, y: 0, w: 1, h: 1 } },
            { depth: 0, name: "Row", rect: { x: 0, y: 1, w: 1, h: 1 } },
            { depth: 0, name: "App", rect: { x: 0, y: 0, w: 1, h: 1 } },
        ]), true);
        expect(out.split("\n")[0]).toBe("Row: 2");
    });
    it("reports off-screen and dropped counts", () => {
        const out = formatChromiumLayout(layout([], { offscreen: 4, dropped: 2 }), false);
        expect(out).toContain("4 component(s)");
        expect(out).toContain("2 component(s) past");
    });
});

describe("buildLayoutCollectJs", () => {
    it("parses", () => {
        expect(() => new Function(`return ${buildLayoutCollectJs(true)};`)).not.toThrow();
    });
});

const inspectRaw = (over: Partial<RawInspect> = {}): RawInspect => ({
    viewport: { w: 380, h: 600, dpr: 2 },
    element: "<button.speak>",
    testID: null,
    frame: { x: 10, y: 20, w: 30, h: 40 },
    style: { display: "flex" },
    component: "SpeakButton",
    props: { onClick: "[Function handleSpeak]" },
    hierarchy: [{ name: "SpeakButton", frame: { x: 10, y: 20, w: 30, h: 40 } }, { name: "PopoverApp", frame: null }],
    ...over,
});

describe("formatChromiumInspect", () => {
    it("converts every frame to delivered px", () => {
        const out = formatChromiumInspect(inspectRaw(), true);
        const json = JSON.parse(out.slice(0, out.indexOf("\n\nSource")));
        expect(json.frame).toEqual({ x: 20, y: 40, width: 60, height: 80 });
        expect(json.hierarchy[0].frame).toEqual({ x: 20, y: 40, width: 60, height: 80 });
        expect(json.hierarchy[1]).toEqual({ name: "PopoverApp" });
        expect(json.props.onClick).toBe("[Function handleSpeak]");
    });
    it("omits frames when includeFrame is false", () => {
        const out = formatChromiumInspect(inspectRaw(), false);
        expect(out).not.toContain('"frame"');
    });
    it("prints source when React provides it, and says why when it does not", () => {
        expect(formatChromiumInspect(inspectRaw({ source: { file: "/src/Speak.tsx", line: 12, column: 3 } }), true)).toContain("Source: /src/Speak.tsx:12:3");
        expect(formatChromiumInspect(inspectRaw(), true)).toContain("Source: unavailable");
    });
});

describe("formatChromiumInspect without React", () => {
    it("does not blame React for a missing source on a page with no component", () => {
        const out = formatChromiumInspect(inspectRaw({ component: undefined, props: undefined }), true);
        expect(out).toContain("Source: no React component at this point");
        expect(out).not.toContain("React 19");
    });
});

describe("formatChromiumMeasure", () => {
    it("reports frame and centre in delivered px, and flags an element scrolled out of view", () => {
        const out = formatChromiumMeasure("Row", { x: 0, y: 700, w: 380, h: 40 }, { w: 380, h: 600, dpr: 2 }, true);
        expect(out).toContain("Frame: (0.0, 1400.0) 760.0x80.0");
        expect(out).toContain("Center: (380.0, 1440.0)");
        expect(out).toContain("scrolled or clipped out of view");
    });
    it("stays quiet about an element on screen, even one inside the viewport box of a scroll container", () => {
        expect(formatChromiumMeasure("Row", { x: 0, y: 10, w: 10, h: 10 }, { w: 380, h: 600, dpr: 1 }, false)).not.toContain("out of view");
    });
});

describe("buildInspectJs", () => {
    it("parses", () => {
        expect(() => new Function(`return ${buildInspectJs(10, 20, true)};`)).not.toThrow();
    });
});
