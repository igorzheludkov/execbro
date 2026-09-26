/**
 * Reading the screen of a chromium target: get_screen_state, get_screen_layout,
 * inspect_at_point, measure, and the screenshot's element summary.
 *
 * Same split as chromium.ts: an injected script collects facts in CSS pixels,
 * TypeScript decides and converts to delivered-screenshot pixels with pxPerCss,
 * the one factor screenshot and tap use. The screen-state collector's output is
 * turned into the mobile ScreenState type, so formatScreenStateSummary renders it
 * and chromium output reads exactly like mobile output.
 *
 * Design: docs/devtools-core/specs/2026-09-19-chromium-platform-support-design.md (P5)
 */
import type { ConnectedApp } from "./types.js";
import { evaluateJson } from "./cdpCommand.js";
import { FIBER_ROOTS_JS } from "./injected/fiberRoots.js";
import { pxPerCss, chromiumViewport, collectDomTargets, type ChromiumViewport } from "./chromium.js";
import type { ScreenState, ScreenStateOverlay, ScreenStatePressable } from "./screenState.js";

export interface CssRect { x: number; y: number; w: number; h: number }

/** Collected elements past this are counted, not listed. Pressables are kept first. */
export const SCREEN_NODE_CAP = 400;

/**
 * Injected helpers shared by every collector in this file. Declarations only, so a
 * test can pull one out with `new Function(DOM_HELPERS_JS + "; return name;")`.
 */
export const DOM_HELPERS_JS = `
function norm(s) { return String(s == null ? "" : s).split(/\\s+/).join(" ").trim(); }
function testIdOf(el) { return el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.id || null; }
function reactProp(el, prefix) {
    var ks = Object.keys(el);
    for (var i = 0; i < ks.length; i++) if (ks[i].indexOf(prefix) === 0) return el[ks[i]];
    return null;
}
function nameOf(t) {
    if (!t || (typeof t !== "function" && typeof t !== "object")) return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type ? nameOf(t.type) : null) || null;
}
function componentOf(el) {
    for (var f = reactProp(el, "__reactFiber$"); f; f = f.return) {
        var n = typeof f.type === "string" ? null : nameOf(f.type);
        if (n) return n;
    }
    return null;
}
var NOT_TEXT = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"];
function isEditable(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
    return el.tagName === "INPUT" && NOT_TEXT.indexOf(String(el.type).toLowerCase()) < 0;
}
// A password never leaves the page, even into an agent's transcript.
function safeValue(el) {
    if (el.isContentEditable) return el.innerText;
    if (el.value == null) return null;
    return String(el.type).toLowerCase() === "password" ? (el.value ? "[password]" : "") : String(el.value);
}
function labelOf(el) {
    // A select's own <label> usually wraps it, so the label's innerText lists every option.
    var s = el.getAttribute("aria-label") ||
        (el.tagName === "SELECT" && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : "") ||
        (el.labels && el.labels[0] ? el.labels[0].innerText : "") ||
        (isEditable(el) || el.tagName === "SELECT" ? "" : el.innerText) ||
        el.getAttribute("title") || el.getAttribute("alt");
    if (!s && el.querySelector) { var img = el.querySelector("img[alt]"); s = img ? img.getAttribute("alt") : ""; }
    s = norm(s);
    return s ? s.slice(0, 80) : null;
}
function describe(el) {
    var cls = typeof el.className === "string" ? el.className.split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    return "<" + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls.length ? "." + cls.join(".") : "") + ">";
}
// The part of el (or of box, a rect inside it) actually on screen: clipped to the
// viewport and to every overflow-clipping ancestor. null = not rendered,
// "off" = rendered but scrolled or clipped out of view.
function visibleRect(el, box) {
    var b = box || el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return null;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    var x1 = Math.max(b.left, 0), y1 = Math.max(b.top, 0), x2 = Math.min(b.right, innerWidth), y2 = Math.min(b.bottom, innerHeight);
    for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        var s = getComputedStyle(p);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") {
            var c = p.getBoundingClientRect();
            x1 = Math.max(x1, c.left); y1 = Math.max(y1, c.top); x2 = Math.min(x2, c.right); y2 = Math.min(y2, c.bottom);
        }
    }
    return x2 - x1 >= 1 && y2 - y1 >= 1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : "off";
}
// The element a wheel at (x, y) scrolls on this axis: the nearest ancestor whose
// overflow scrolls and whose content overflows, else the page if it scrolls. A
// scroller on the other axis is returned when nothing scrolls on this one, so the
// verdict can say "wrong axis" instead of "nothing here".
function canScroll(el, horizontal) {
    var s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(horizontal ? s.overflowX : s.overflowY) &&
        (horizontal ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight);
}
function scrollerAt(x, y, horizontal) {
    var root = document.scrollingElement || document.documentElement;
    var other = null;
    for (var el = document.elementFromPoint(x, y); el && el !== root; el = el.parentElement) {
        if (canScroll(el, horizontal)) return el;
        if (!other && canScroll(el, !horizontal)) other = el;
    }
    function pageScrolls(h) {
        var hidden = function (e) { var s = getComputedStyle(e); return (h ? s.overflowX : s.overflowY) === "hidden"; };
        return !hidden(root) && !hidden(document.body) && (h ? root.scrollWidth > root.clientWidth : root.scrollHeight > root.clientHeight);
    }
    if (!document.elementFromPoint(x, y)) return null;
    if (pageScrolls(horizontal)) return root;
    return other || (pageScrolls(!horizontal) ? root : null);
}
function readScroller(el) {
    if (!el || el.isConnected === false) return { container: null };
    var isRoot = el === (document.scrollingElement || document.documentElement);
    return {
        container: isRoot ? "the page" : describe(el),
        top: el.scrollTop, left: el.scrollLeft,
        maxTop: isRoot || canScroll(el, false) ? Math.max(0, el.scrollHeight - el.clientHeight) : 0,
        maxLeft: isRoot || canScroll(el, true) ? Math.max(0, el.scrollWidth - el.clientWidth) : 0,
        // A scroller at its end hands the wheel on to the page; these show whether it moved.
        // ponytail: only the scrolling element is watched, not intermediate scrollers in the chain.
        page: isRoot ? undefined : { top: (document.scrollingElement || document.documentElement).scrollTop, left: (document.scrollingElement || document.documentElement).scrollLeft }
    };
}
// Pressables with no other pressable inside. Only these own the text under them as
// their label: a click-wrapper (a modal backdrop, an app shell listening for clicks
// outside) would otherwise swallow every text line on the screen.
// ponytail: O(n^2) contains() over pressables; fine for hundreds, index by depth if pages get huge.
function leafPresses(els) {
    return els.filter(function (el) { return !els.some(function (o) { return o !== el && el.contains(o); }); });
}
function joinRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: x, y: y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
// The DOM elements a component renders at its top level (through fragments and
// nested components, not into child elements).
function hostsOf(f, acc) {
    for (var c = f.child; c; c = c.sibling) {
        if (c.stateNode && c.stateNode.nodeType === 1) acc.push(c.stateNode);
        else hostsOf(c, acc);
    }
    return acc;
}
var STYLE_KEYS = ["display", "position", "flexDirection", "justifyContent", "alignItems", "gap", "padding", "margin",
    "width", "height", "backgroundColor", "color", "fontSize", "fontWeight", "borderRadius", "opacity", "overflow", "zIndex"];
var STYLE_SKIP = ["", "0px", "none", "normal", "static", "visible", "auto", "rgba(0, 0, 0, 0)"];
function styleOf(el) {
    var cs = getComputedStyle(el), out = {};
    STYLE_KEYS.forEach(function (k) {
        var v = cs[k];
        if (v && STYLE_SKIP.indexOf(v) < 0 && !(k === "opacity" && v === "1") && !(k === "fontWeight" && v === "400")) out[k] = v;
    });
    return out;
}
`;

const VIEWPORT_FIELDS_JS = `{ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hidden: document.visibilityState === "hidden" }`;

export interface RawScreenNode {
    kind: "press" | "text" | "img";
    /** Visible part, CSS px, viewport-relative. */
    rect: CssRect;
    /** Overlay this node sits in, or (covered) the one on top of it. */
    overlay: number | null;
    /** Its visible centre hits overlay `overlay`, so a tap there lands on the overlay. */
    covered: boolean;
    label?: string | null;
    component?: string | null;
    testID?: string | null;
    input?: { value: string | null; placeholder: string | null };
    checked?: boolean;
    text?: string;
    src?: string | null;
    alt?: string | null;
}

export interface RawScreen {
    viewport: ChromiumViewport;
    url: string;
    title: string;
    overlays: Array<{ type: "Modal" | "Alert" | "Unknown"; title: string | null }>;
    nodes: RawScreenNode[];
    /** Listed kinds that exist but are scrolled or clipped out of view. */
    offscreen: number;
    /** Nodes past SCREEN_NODE_CAP. */
    dropped: number;
}

export function buildScreenCollectJs(): string {
    return `(function () {
    ${DOM_HELPERS_JS}
    var CAP = ${SCREEN_NODE_CAP};
    var PRESS_SEL = "button, a[href], summary, select, input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true], " +
        "[role=button], [role=link], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option], [role=radio], [onclick]";
    var OVERLAY_SEL = "dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]";
    var SKIP_TEXT = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "OPTION", "SELECT"];
    var vp = ${VIEWPORT_FIELDS_JS};
    var all = document.body ? Array.prototype.slice.call(document.body.querySelectorAll("*")) : [];
    function isPress(el) {
        // Not el.onclick: a handler assigned as a property is usually delegation
        // on a container (FluentTalk's #root has one), not a target.
        if (el.matches(PRESS_SEL)) return true;
        var p = reactProp(el, "__reactProps$");
        return !!(p && (p.onClick || p.onMouseDown || p.onMouseUp || p.onPointerDown || p.onPointerUp));
    }
    var pressEls = all.filter(isPress);
    var pressSet = new Set(leafPresses(pressEls));
    function insidePress(el) { for (var p = el; p; p = p.parentElement) if (pressSet.has(p)) return true; return false; }
    function shown(el) { var r = visibleRect(el); return r && r !== "off"; }
    var layers = all.filter(function (el) { return el.matches(OVERLAY_SEL) && shown(el); });
    layers = layers.filter(function (el) { return !layers.some(function (o) { return o !== el && o.contains(el); }); });
    var overlays = layers.map(function (el) {
        var h = el.querySelector("h1, h2, h3, [role=heading]");
        return {
            type: el.getAttribute("role") === "alertdialog" ? "Alert" : "Modal",
            title: norm(el.getAttribute("aria-label") || (h ? h.innerText : "")).slice(0, 80) || null
        };
    });
    var found = [], offscreen = 0;
    function consider(kind, el, box, extra) {
        var r = visibleRect(el, box);
        if (r === "off") { offscreen++; return; }
        if (r) found.push({ kind: kind, el: el, rect: r, extra: extra });
    }
    pressEls.forEach(function (el) {
        var info = { label: labelOf(el), component: componentOf(el), testID: testIdOf(el) };
        if (isEditable(el)) info.input = { value: safeValue(el) || null, placeholder: el.getAttribute("placeholder") };
        var type = String(el.type || "").toLowerCase();
        if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) info.checked = !!el.checked;
        else if (el.hasAttribute("aria-checked")) info.checked = el.getAttribute("aria-checked") === "true";
        consider("press", el, null, info);
    });
    Array.prototype.slice.call(document.querySelectorAll("img, [role=img]")).forEach(function (el) {
        if (!insidePress(el)) consider("img", el, null, { src: el.getAttribute("src"), alt: el.getAttribute("alt") || el.getAttribute("aria-label") });
    });
    if (document.body) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (var t = walker.nextNode(); t; t = walker.nextNode()) {
            var s = norm(t.nodeValue), pe = t.parentElement;
            if (!s || !pe || SKIP_TEXT.indexOf(pe.tagName) >= 0 || insidePress(pe)) continue;
            var range = document.createRange();
            range.selectNodeContents(t);
            consider("text", pe, range.getBoundingClientRect(), { text: s });
        }
    }
    // Pass 1: what a tap at each visible centre would actually hit. The hit is
    // promoted to its outermost positioned ancestor, so everything under one sheet
    // reports the same layer.
    // ponytail: a later layer that contains an earlier one is not merged; merge if two groups for one sheet ever show up.
    found.forEach(function (n) {
        var hit = document.elementFromPoint(n.rect.x + n.rect.w / 2, n.rect.y + n.rect.h / 2);
        if (!hit || hit === n.el || n.el.contains(hit) || hit.contains(n.el)) return;
        var layer = hit;
        for (var p = hit.parentElement; p && p !== document.body && !p.contains(n.el); p = p.parentElement) {
            var pos = getComputedStyle(p).position;
            if (pos === "fixed" || pos === "absolute" || pos === "sticky") layer = p;
        }
        var i = -1;
        for (var j = 0; j < layers.length; j++) if (layers[j] === layer || layers[j].contains(layer)) { i = j; break; }
        if (i < 0) { layers.push(layer); overlays.push({ type: "Unknown", title: describe(layer) }); i = layers.length - 1; }
        n.coveredBy = i;
    });
    // Pass 2: membership, pressables first so the cap drops text before targets.
    var rank = { press: 0, img: 1, text: 2 };
    found.sort(function (a, b) { return rank[a.kind] - rank[b.kind]; });
    var nodes = [], dropped = 0;
    found.forEach(function (n) {
        if (nodes.length >= CAP) { dropped++; return; }
        var home = null;
        for (var j = 0; j < layers.length; j++) if (layers[j] === n.el || layers[j].contains(n.el)) { home = j; break; }
        var covered = n.coveredBy !== undefined;
        var node = { kind: n.kind, rect: n.rect, overlay: covered ? n.coveredBy : home, covered: covered };
        for (var k in n.extra) node[k] = n.extra[k];
        nodes.push(node);
    });
    return JSON.stringify({ viewport: vp, url: location.href, title: document.title, overlays: overlays, nodes: nodes, offscreen: offscreen, dropped: dropped });
})()`;
}

function routeOf(url: string): ScreenState["route"] {
    try {
        const u = new URL(url);
        // A data: URL's "path" is the whole document.
        const name = u.protocol === "data:" ? "(data: URL)" : u.pathname + u.hash;
        const params = [...u.searchParams.keys()].length > 0 ? Object.fromEntries(u.searchParams) : null;
        return { name, params, stack: [name] };
    } catch {
        return null;
    }
}

export function rawToScreenState(raw: RawScreen): ScreenState {
    const k = pxPerCss(raw.viewport);
    const geom = (r: CssRect) => ({
        center: { x: Math.round((r.x + r.w / 2) * k), y: Math.round((r.y + r.h / 2) * k) },
        bounds: { x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.w * k), height: Math.round(r.h * k) },
    });
    const overlays: ScreenStateOverlay[] = raw.overlays.map((o) => ({ type: o.type, title: o.title, pressables: [], texts: [], images: [] }));
    const ss: ScreenState = { route: routeOf(raw.url), overlays, pressables: [], texts: [], images: [], notes: [] };
    for (const n of raw.nodes) {
        const g = geom(n.rect);
        const blocked = n.covered ? { blockedByOverlay: true } : {};
        const home = n.overlay !== null && !n.covered ? overlays[n.overlay] : null;
        if (n.kind === "press") {
            const p: ScreenStatePressable = {
                ...g,
                ...blocked,
                label: n.label ?? null,
                component: n.component ?? null,
                testID: n.testID ?? null,
                ...(n.input ? { isInput: true, inputValue: n.input.value, inputPlaceholder: n.input.placeholder } : {}),
                ...(n.checked !== undefined ? { switchValue: n.checked } : {}),
            };
            (home ? home.pressables : ss.pressables).push(p);
        } else if (n.kind === "text") {
            (home ? home.texts! : ss.texts).push({ ...g, ...blocked, text: n.text ?? "" });
        } else {
            (home ? home.images! : ss.images).push({ ...g, ...blocked, src: n.src ?? null, alt: n.alt ?? null });
        }
    }
    const notes = ss.notes!;
    notes.push(`chromium page "${raw.title}": the route is the page location, so a router that never changes the URL is not seen.`);
    if (raw.viewport.hidden) notes.push("The window is hidden (document.visibilityState). Nothing listed is visible or tappable until it is shown.");
    if (raw.offscreen > 0) notes.push(`${raw.offscreen} more element(s) are scrolled or clipped out of view. tap(testID/text/component) scrolls its target into view first.`);
    if (raw.dropped > 0) notes.push(`${raw.dropped} element(s) past the ${SCREEN_NODE_CAP}-element cap are not listed.`);
    return ss;
}

export async function chromiumScreenState(app: ConnectedApp): Promise<ScreenState> {
    return rawToScreenState(await evaluateJson<RawScreen>(app.ws, buildScreenCollectJs()));
}

export const LAYOUT_NODE_CAP = 500;

export interface RawLayoutNode { depth: number; name: string; rect: CssRect; testID?: string; text?: string; style?: Record<string, string> }
export interface RawLayout { viewport: ChromiumViewport; nodes: RawLayoutNode[]; offscreen: number; dropped: number; error?: string }

/** The visible React component tree: each component framed by the visible union of the DOM it renders. */
export function buildLayoutCollectJs(extended: boolean): string {
    return `(function () {
    ${FIBER_ROOTS_JS}
    ${DOM_HELPERS_JS}
    var vp = ${VIEWPORT_FIELDS_JS};
    var roots = __eb_fiberRoots(true);
    if (roots.length === 0) return JSON.stringify({ viewport: vp, nodes: [], offscreen: 0, dropped: 0, error: "No React root found on this page. get_screen_state lists its DOM elements without React." });
    var out = [], offscreen = 0, dropped = 0;
    function walk(f, depth) {
        for (; f; f = f.sibling) {
            var name = typeof f.type === "string" ? null : nameOf(f.type);
            if (!name) { walk(f.child, depth); continue; }
            var hs = hostsOf(f, []), r = null, any = false;
            hs.forEach(function (h) { var v = visibleRect(h); if (v === "off") any = true; else if (v) r = joinRect(r, v); });
            if (!r) { if (any) offscreen++; continue; }
            if (out.length >= ${LAYOUT_NODE_CAP}) { dropped++; continue; }
            var node = { depth: depth, name: name, rect: r };
            var tid = hs[0] && testIdOf(hs[0]);
            if (tid) node.testID = tid;
            var txt = hs.length === 1 ? norm(hs[0].innerText) : "";
            if (txt && txt.length <= 60) node.text = txt;
            if (${extended} && hs[0]) node.style = styleOf(hs[0]);
            out.push(node);
            walk(f.child, depth + 1);
        }
    }
    roots.forEach(function (root) { walk(root.current, 0); });
    return JSON.stringify({ viewport: vp, nodes: out, offscreen: offscreen, dropped: dropped });
})()`;
}

export function formatChromiumLayout(raw: RawLayout, summary: boolean): string {
    const k = pxPerCss(raw.viewport);
    const px = (v: number) => Math.round(v * k);
    if (summary) {
        const counts = new Map<string, number>();
        for (const n of raw.nodes) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1]).map(([name, c]) => `${name}: ${c}`).join("\n");
    }
    const lines = raw.nodes.map((n, i) => {
        const next = raw.nodes[i + 1];
        // A parent whose only DOM is its child's repeats the child's text; keep the deepest.
        const text = n.text && !(next && next.depth > n.depth && next.text === n.text) ? ` "${n.text}"` : "";
        const style = n.style && Object.keys(n.style).length > 0
            ? ` {${Object.entries(n.style).map(([a, b]) => `${a}: ${b}`).join(", ")}}`
            : "";
        return `${"  ".repeat(n.depth)}${n.name} (${px(n.rect.x)},${px(n.rect.y)} ${px(n.rect.w)}x${px(n.rect.h)})` +
            `${n.testID ? ` testID="${n.testID}"` : ""}${text}${style}`;
    });
    if (raw.viewport.hidden) lines.push("", "The window is hidden (document.visibilityState). Nothing listed is visible until it is shown.");
    if (raw.offscreen > 0) lines.push("", `${raw.offscreen} component(s) are scrolled or clipped out of view and not listed.`);
    if (raw.dropped > 0) lines.push("", `${raw.dropped} component(s) past the ${LAYOUT_NODE_CAP}-component cap are not listed.`);
    return lines.join("\n");
}

export async function chromiumScreenLayout(app: ConnectedApp, opts: { extended: boolean; summary: boolean }): Promise<string> {
    const raw = await evaluateJson<RawLayout>(app.ws, buildLayoutCollectJs(opts.extended));
    if (raw.error) throw new Error(raw.error);
    return formatChromiumLayout(raw, opts.summary);
}

export interface RawInspect {
    viewport: ChromiumViewport;
    error?: string;
    element: string;
    testID: string | null;
    frame: CssRect;
    style: Record<string, string>;
    component?: string;
    props?: Record<string, unknown>;
    source?: { file: string; line: number; column: number };
    hierarchy: Array<{ name: string; frame: CssRect | null }>;
}

export function buildInspectJs(cssX: number, cssY: number, includeProps: boolean): string {
    return `(function () {
    ${DOM_HELPERS_JS}
    var vp = ${VIEWPORT_FIELDS_JS};
    var el = document.elementFromPoint(${cssX}, ${cssY});
    if (!el) return JSON.stringify({ viewport: vp, error: "Nothing at this point: it is outside the viewport." });
    function box(e) { var r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
    function unionBox(els) { var r = null; els.forEach(function (e) { var b = box(e); if (b.w > 0 || b.h > 0) r = joinRect(r, b); }); return r; }
    function propsOf(mp) {
        var out = {};
        Object.keys(mp || {}).forEach(function (k) {
            if (k === "children") return;
            var v = mp[k];
            if (typeof v === "function") out[k] = "[Function" + (v.name ? " " + v.name : "") + "]";
            else if (v && typeof v === "object") {
                if (v.nodeType === 1) { out[k] = describe(v); return; }
                try {
                    var s = JSON.stringify(v);
                    out[k] = s.length > 200 ? (Array.isArray(v) ? "[Array(" + v.length + ")]" : "[Object]") : v;
                } catch (e) { out[k] = "[Object]"; }
            } else out[k] = v;
        });
        return out;
    }
    var res = { viewport: vp, element: describe(el), testID: testIdOf(el), frame: box(el), style: styleOf(el), hierarchy: [] };
    var named = null, seen = {};
    for (var f = reactProp(el, "__reactFiber$"); f; f = f.return) {
        var n = typeof f.type === "string" ? null : nameOf(f.type);
        if (!n) continue;
        if (!named) named = f;
        if (seen[n] || res.hierarchy.length >= 15) continue;
        seen[n] = true;
        res.hierarchy.push({ name: n, frame: unionBox(hostsOf(f, [])) });
    }
    if (named) {
        res.component = nameOf(named.type);
        var src = named._debugSource;
        if (src && src.fileName) res.source = { file: src.fileName, line: src.lineNumber, column: src.columnNumber };
        if (${includeProps}) res.props = propsOf(named.memoizedProps);
    } else {
        for (var p = el.parentElement; p && res.hierarchy.length < 8; p = p.parentElement) res.hierarchy.push({ name: describe(p), frame: box(p) });
    }
    return JSON.stringify(res);
})()`;
}

export function formatChromiumInspect(raw: RawInspect, includeFrame: boolean): string {
    const k = pxPerCss(raw.viewport);
    const frame = (r: CssRect) => ({ x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.w * k), height: Math.round(r.h * k) });
    const out = {
        element: raw.element,
        ...(raw.component ? { component: raw.component } : {}),
        ...(raw.testID ? { testID: raw.testID } : {}),
        ...(includeFrame ? { frame: frame(raw.frame) } : {}),
        style: raw.style,
        ...(raw.props ? { props: raw.props } : {}),
        hierarchy: raw.hierarchy.map((h) => (includeFrame && h.frame ? { name: h.name, frame: frame(h.frame) } : { name: h.name })),
    };
    const source = raw.source
        ? `Source: ${raw.source.file}:${raw.source.line}:${raw.source.column}`
        : raw.component
            ? "Source: unavailable on chromium (React 19 records no _debugSource). Grep the component name to find its file."
            : "Source: no React component at this point; the hierarchy lists DOM ancestors.";
    return `${JSON.stringify(out, null, 2)}\n\n${source}`;
}

export async function chromiumInspectAtPoint(
    app: ConnectedApp,
    x: number,
    y: number,
    opts: { includeProps: boolean; includeFrame: boolean }
): Promise<string> {
    const k = pxPerCss(await chromiumViewport(app));
    const raw = await evaluateJson<RawInspect>(app.ws, buildInspectJs(x / k, y / k, opts.includeProps));
    if (raw.error) throw new Error(raw.error);
    return formatChromiumInspect(raw, opts.includeFrame);
}

export function formatChromiumMeasure(name: string, rect: CssRect, vp: ChromiumViewport, outOfView: boolean): string {
    const k = pxPerCss(vp);
    const [x, y, w, h] = [rect.x, rect.y, rect.w, rect.h].map((v) => v * k);
    const lines = [
        `Component: ${name}`,
        `Frame: (${x.toFixed(1)}, ${y.toFixed(1)}) ${w.toFixed(1)}x${h.toFixed(1)}`,
        `Center: (${(x + w / 2).toFixed(1)}, ${(y + h / 2).toFixed(1)})`,
    ];
    if (outOfView) {
        lines.push("It is scrolled or clipped out of view (outside the viewport or its scroll container), so a tap at this centre lands on whatever is shown there. tap({ component }) scrolls it into view first.");
    }
    return lines.join("\n");
}

/** visibleRect of a collected target: "off" when scrolled or clipped away, as get_screen_state counts it. */
function buildOutOfViewJs(i: number): string {
    return `(function () {
    ${DOM_HELPERS_JS}
    var el = (globalThis.__eb_domTargets || [])[${i}];
    return JSON.stringify(!!el && visibleRect(el) === "off");
})()`;
}

export async function chromiumMeasure(app: ConnectedApp, componentName: string, index: number): Promise<string> {
    const found = await collectDomTargets(app, { mode: "tap", component: componentName });
    const c = found.candidates[index];
    if (!c) {
        throw new Error(found.total === 0
            ? `No visible element renders component "${componentName}". find_components lists component names.`
            : `index ${index} is out of range: ${found.total} visible instance(s) of "${componentName}".`);
    }
    const outOfView = await evaluateJson<boolean>(app.ws, buildOutOfViewJs(c.i));
    return formatChromiumMeasure(componentName, c.rect, found.viewport, outOfView);
}

/** Find the scroller under CSS (x, y), remember it for SCROLL_READ_JS, and read its offsets. */
export function buildScrollProbeJs(x: number, y: number, horizontal: boolean): string {
    return `(function () {
    ${DOM_HELPERS_JS}
    var el = scrollerAt(${x}, ${y}, ${horizontal});
    globalThis.__eb_scroller = el;
    return JSON.stringify(readScroller(el));
})()`;
}

/** Re-read the scroller the last probe found, so before and after compare the same element. */
export const SCROLL_READ_JS = `(function () {
    ${DOM_HELPERS_JS}
    return JSON.stringify(readScroller(globalThis.__eb_scroller));
})()`;

/** document.activeElement, named: tag, testID, label, and its value (a password never leaves the page). */
export const ACTIVE_ELEMENT_JS = `(function () {
    ${DOM_HELPERS_JS}
    var el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return JSON.stringify(null);
    return JSON.stringify({ element: describe(el), testID: testIdOf(el), label: labelOf(el), placeholder: el.getAttribute("placeholder"), value: isEditable(el) ? safeValue(el) : null });
})()`;
