import { describe, it, expect, afterEach } from "@jest/globals";
import { buildDomCollectJs, buildDomPrepareJs, type DomCollection, type DomQuery } from "../../core/chromium.js";

/**
 * Just enough DOM to run the injected collector and prepare scripts for real.
 * Only what those scripts touch; a hidden element measures 0x0, as in a browser.
 */
interface FakeEl {
    tagName: string;
    attrs: Record<string, string>;
    textContent: string;
    innerText: string;
    hidden?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
    type?: string;
    value?: string;
    isContentEditable?: boolean;
    children: FakeEl[];
    parent?: FakeEl;
    scrolls: unknown[];
}

function el(tagName: string, opts: Partial<FakeEl> = {}, children: FakeEl[] = []): FakeEl {
    const e: FakeEl = { tagName, attrs: {}, textContent: "", innerText: "", scrolls: [], ...opts, children };
    for (const c of children) c.parent = e;
    return e;
}

function descendants(e: FakeEl): FakeEl[] {
    return e.children.flatMap((c) => [c, ...descendants(c)]);
}

function wire(e: FakeEl): void {
    const node = e as unknown as Record<string, unknown>;
    node.id = e.attrs.id ?? "";
    node.isConnected = true;
    node.getAttribute = (n: string) => e.attrs[n] ?? null;
    node.getBoundingClientRect = () => {
        const r = e.hidden ? { x: 0, y: 0, width: 0, height: 0 } : (e.rect ?? { x: 10, y: 10, width: 100, height: 20 });
        return { ...r, top: r.y, left: r.x, bottom: r.y + r.height, right: r.x + r.width };
    };
    node.contains = (o: FakeEl) => { for (let p: FakeEl | undefined = o; p; p = p.parent) if (p === e) return true; return false; };
    node.querySelectorAll = (sel: string) => {
        const all = descendants(e);
        return sel === "*" ? all : all.filter((d) => d.tagName === "INPUT" || d.tagName === "TEXTAREA" || d.isContentEditable);
    };
    node.scrollIntoView = (opts: unknown) => { e.scrolls.push(opts); };
    e.children.forEach(wire);
}

const g = globalThis as Record<string, unknown>;
const GLOBALS = ["document", "getComputedStyle", "innerWidth", "innerHeight", "devicePixelRatio", "__eb_domTargets"];

function mount(body: FakeEl): void {
    wire(body);
    g.document = { body, activeElement: body, elementFromPoint: () => null };
    g.getComputedStyle = () => ({ visibility: "visible" });
    g.innerWidth = 400;
    g.innerHeight = 600;
    g.devicePixelRatio = 1;
}

const collect = (q: DomQuery) => JSON.parse(new Function(`return ${buildDomCollectJs(q)};`)()) as DomCollection;

afterEach(() => { for (const k of GLOBALS) delete g[k]; });

describe("DOM collector, text mode", () => {
    it("does not fall back to a visible container when the matching text is hidden inside it", () => {
        const hidden = el("SPAN", { textContent: "Delete", innerText: "", hidden: true });
        const menu = el("DIV", { textContent: "Menu Delete", innerText: "Menu" }, [el("SPAN", { textContent: "Menu", innerText: "Menu" }), hidden]);
        mount(el("BODY", {}, [menu]));
        expect(collect({ mode: "tap", text: "Delete" }).candidates).toEqual([]);
    });

    it("still finds the visible innermost match", () => {
        const btn = el("BUTTON", { textContent: "Save", innerText: "Save" }, [el("SPAN", { textContent: "Save", innerText: "Save" })]);
        mount(el("BODY", {}, [btn]));
        const r = collect({ mode: "tap", text: "Save" });
        expect(r.candidates.map((c) => c.tag)).toEqual(["span"]);
    });
});

describe("DOM collector, input mode on a wrapper", () => {
    it("lists every field under a wrapper testID instead of picking the first", () => {
        const form = el("FORM", { attrs: { "data-testid": "login-form" } }, [
            el("INPUT", { type: "email", value: "" }),
            el("INPUT", { type: "password", value: "" }),
        ]);
        mount(el("BODY", {}, [form]));
        expect(collect({ mode: "input", testID: "login-form" }).candidates).toHaveLength(2);
    });

    it("resolves a wrapper around exactly one field", () => {
        const wrap = el("DIV", { attrs: { "data-testid": "email" } }, [el("INPUT", { type: "email", value: "" }), el("BUTTON", { type: "submit" })]);
        mount(el("BODY", {}, [wrap]));
        expect(collect({ mode: "input", testID: "email" }).candidates.map((c) => c.tag)).toEqual(["input"]);
    });
});

describe("prepare script", () => {
    it("scrolls instantly, so the rect it reads next is the post-scroll one on a scroll-behavior:smooth page", () => {
        const target = el("BUTTON", { rect: { x: 10, y: 900, width: 100, height: 20 } });
        mount(el("BODY", {}, [target]));
        g.__eb_domTargets = [target];
        new Function(`return ${buildDomPrepareJs(0)};`)();
        expect(target.scrolls).toEqual([{ block: "center", inline: "center", behavior: "instant" }]);
    });
});
