/**
 * Chromium (Electron / Chrome) screen, pointer and text primitives.
 *
 * Coordinate contract: tools speak delivered-screenshot pixels, the Input domain
 * speaks CSS pixels, and pxPerCss is the only conversion between them. It is
 * derived from the live viewport on every call rather than stored, so a resized
 * window cannot leave a stale factor behind, and the capture resizes to exactly
 * round(css * pxPerCss) so the image and the conversion agree by construction.
 *
 * Design: docs/devtools-core/specs/2026-09-19-chromium-platform-support-design.md (section 4)
 */
import sharp from "sharp";
import type { ConnectedApp } from "./types.js";
import { sendCdpCommand, evaluateJson } from "./cdpCommand.js";
import { FIBER_ROOTS_JS } from "./injected/fiberRoots.js";
import type { TextEntryResult } from "./textEntry.js";

/** Same API image cap ios.ts and android.ts apply. */
export const CHROMIUM_MAX_DIMENSION = 2000;
export const CAPTURE_TIMEOUT_MS = 8000;

export interface ChromiumViewport {
    w: number;
    h: number;
    dpr: number;
}

/** Delivered-screenshot pixels per CSS pixel: devicePixelRatio, lowered only when the capture would exceed the cap. */
export function pxPerCss(vp: ChromiumViewport): number {
    const longest = Math.max(vp.w, vp.h);
    return longest * vp.dpr > CHROMIUM_MAX_DIMENSION ? CHROMIUM_MAX_DIMENSION / longest : vp.dpr;
}

export const VIEWPORT_JS = "JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })";

export function chromiumViewport(app: ConnectedApp): Promise<ChromiumViewport> {
    return evaluateJson<ChromiumViewport>(app.ws, VIEWPORT_JS);
}

export interface ChromiumShot {
    buffer: Buffer;
    width: number;
    height: number;
    /** raw / delivered, 1 unless downscaled. Same meaning as TapScreenshot.scaleFactor. */
    scaleFactor: number;
    viewport: ChromiumViewport;
}

export async function chromiumCapture(app: ConnectedApp): Promise<ChromiumShot> {
    const viewport = await chromiumViewport(app);
    let data: string;
    try {
        ({ data } = await sendCdpCommand<{ data: string }>(app.ws, "Page.captureScreenshot", { format: "png" }, CAPTURE_TIMEOUT_MS));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            /timed out/.test(msg)
                ? `${msg}. A hidden or minimised window may not paint, and Chromium cannot capture what it does not paint: show the window and retry.`
                : msg
        );
    }
    const k = pxPerCss(viewport);
    const width = Math.round(viewport.w * k);
    const height = Math.round(viewport.h * k);
    const png = Buffer.from(data, "base64");
    const meta = await sharp(png).metadata();
    const img = meta.width === width && meta.height === height ? sharp(png) : sharp(png).resize(width, height, { fit: "fill" });
    return {
        buffer: await img.jpeg({ quality: 85 }).toBuffer(),
        width,
        height,
        scaleFactor: viewport.dpr / k,
        viewport,
    };
}

/** A left click at CSS pixel (x, y). holdMs > 0 holds the button down that long. */
export async function chromiumClick(app: ConnectedApp, x: number, y: number, holdMs = 0): Promise<void> {
    const send = (params: Record<string, unknown>) => sendCdpCommand(app.ws, "Input.dispatchMouseEvent", params);
    await send({ type: "mouseMoved", x, y });
    await send({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    await send({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/** Insert text at the focused element's caret, through the browser's own input pipeline (fires input events React sees). */
export async function chromiumInsertText(app: ConnectedApp, text: string): Promise<void> {
    await sendCdpCommand(app.ws, "Input.insertText", { text });
}

export interface DomQuery {
    mode: "tap" | "input";
    testID?: string;
    text?: string;
    component?: string;
    textMatch?: string;
}

export interface DomCandidate {
    /** Position in globalThis.__eb_domTargets. */
    i: number;
    tag: string;
    text: string;
    testID: string | null;
    label: string | null;
    placeholder: string | null;
    value: string | null;
    /** CSS px, viewport-relative. */
    rect: { x: number; y: number; w: number; h: number };
}

export interface DomCollection {
    viewport: ChromiumViewport;
    candidates: DomCandidate[];
    /** Every match, even past the 50 returned. */
    total: number;
    /** input mode, untargeted: an editable element had focus. */
    focused: boolean;
}

export type DomPick =
    | { kind: "ok"; cand: DomCandidate }
    | { kind: "none" }
    | { kind: "ambiguous"; matches: DomCandidate[] };

export function normText(s: string): string {
    return s.split(/\s+/).join(" ").trim();
}

/**
 * Choose one candidate. The collector already kept only case-insensitive
 * substring matches for text, so the tiers only rank them: exact, then
 * case-insensitive exact, then the rest. Never guesses between equals.
 */
export function pickDomTarget(cands: DomCandidate[], text: string | undefined, index: number | undefined): DomPick {
    let pool = cands;
    if (text !== undefined) {
        const want = normText(text);
        const tiers: Array<(c: DomCandidate) => boolean> = [
            (c) => c.text === want,
            (c) => c.text.toLowerCase() === want.toLowerCase(),
            () => true,
        ];
        pool = tiers.map((t) => cands.filter(t)).find((p) => p.length > 0) ?? [];
    }
    if (index !== undefined) return pool[index] ? { kind: "ok", cand: pool[index] } : { kind: "none" };
    if (pool.length === 0) return { kind: "none" };
    return pool.length === 1 ? { kind: "ok", cand: pool[0] } : { kind: "ambiguous", matches: pool };
}

export function buildDomCollectJs(q: DomQuery): string {
    return `(function () {
    ${FIBER_ROOTS_JS}
    var q = ${JSON.stringify(q)};
    function norm(s) { return String(s == null ? "" : s).split(/\\s+/).join(" ").trim(); }
    var NOT_TEXT = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"];
    function isEditable(el) {
        if (!el || !el.tagName) return false;
        if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
        return el.tagName === "INPUT" && NOT_TEXT.indexOf(String(el.type).toLowerCase()) < 0;
    }
    function editableIn(el) {
        if (isEditable(el)) return el;
        var inner = el.querySelectorAll ? el.querySelectorAll("input, textarea, [contenteditable]") : [];
        for (var n = 0; n < inner.length; n++) if (isEditable(inner[n])) return inner[n];
        return null;
    }
    function testIdOf(el) { return el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.id || null; }
    function labelOf(el) { return norm(el.getAttribute("aria-label") || (el.labels && el.labels[0] ? el.labels[0].innerText : "")) || null; }
    function valueOf(el) { return el.isContentEditable ? el.innerText : (el.value == null ? null : String(el.value)); }
    function textOf(el) { return el.tagName === "INPUT" ? norm(el.value || el.getAttribute("aria-label")) : norm(el.innerText || el.getAttribute("aria-label")); }
    function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }
    var all = document.body ? Array.prototype.slice.call(document.body.querySelectorAll("*")) : [];
    var els = [];
    var focused = false;
    if (q.testID) {
        els = all.filter(function (el) { return testIdOf(el) === q.testID; });
    } else if (q.component) {
        var wantC = q.component.toLowerCase();
        __eb_fiberRoots(true).forEach(function (root) {
            (function walk(f) {
                for (; f; f = f.sibling) {
                    var t = f.type, name = t && (t.displayName || t.name);
                    if (typeof name === "string" && name.toLowerCase() === wantC) {
                        var h = f;
                        while (h && !(h.stateNode instanceof Element)) h = h.child;
                        if (h && els.indexOf(h.stateNode) < 0) els.push(h.stateNode);
                    }
                    walk(f.child);
                }
            })(root.current);
        });
    } else if (q.text) {
        var wantT = norm(q.text).toLowerCase();
        els = all.filter(function (el) {
            return norm(el.tagName === "INPUT" ? el.value : el.textContent).toLowerCase().indexOf(wantT) >= 0 ||
                norm(el.getAttribute("aria-label")).toLowerCase().indexOf(wantT) >= 0;
        }).filter(visible);
        // ponytail: O(k^2) innermost filter over matches; k is small (matches plus their ancestors).
        els = els.filter(function (el) { return !els.some(function (o) { return o !== el && el.contains(o); }); });
    }
    if (q.mode === "input") {
        if (q.textMatch) {
            var wantM = norm(q.textMatch).toLowerCase();
            els = all.filter(isEditable).filter(function (el) {
                return [el.getAttribute("placeholder"), labelOf(el), valueOf(el)].some(function (s) {
                    return norm(s).toLowerCase().indexOf(wantM) >= 0;
                });
            });
        } else if (q.testID || q.component) {
            els = els.map(editableIn).filter(function (el, n, a) { return el && a.indexOf(el) === n; });
        } else {
            var active = document.activeElement;
            focused = isEditable(active);
            els = focused ? [active] : all.filter(isEditable);
        }
    }
    els = els.filter(visible);
    globalThis.__eb_domTargets = els;
    return JSON.stringify({
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        focused: focused,
        total: els.length,
        candidates: els.slice(0, 50).map(function (el, n) {
            var r = el.getBoundingClientRect();
            return {
                i: n, tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 200), testID: testIdOf(el),
                label: labelOf(el), placeholder: el.getAttribute("placeholder"),
                value: isEditable(el) ? valueOf(el) : null,
                rect: { x: r.x, y: r.y, w: r.width, h: r.height }
            };
        })
    });
})()`;
}

export function buildDomPrepareJs(i: number): string {
    return `(function () {
    var el = (globalThis.__eb_domTargets || [])[${i}];
    if (!el || !el.isConnected) return JSON.stringify({ error: "The element left the page between lookup and tap. Retry." });
    var r = el.getBoundingClientRect();
    var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    var scrolled = false;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) {
        el.scrollIntoView({ block: "center", inline: "center" });
        r = el.getBoundingClientRect();
        cx = r.x + r.width / 2;
        cy = r.y + r.height / 2;
        scrolled = true;
    }
    var hit = document.elementFromPoint(cx, cy);
    var covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el)
        ? "<" + hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") +
          (hit.getAttribute("data-testid") ? ' data-testid="' + hit.getAttribute("data-testid") + '"' : "") + ">"
        : null;
    return JSON.stringify({ x: cx, y: cy, scrolled: scrolled, covered: covered });
})()`;
}

export function collectDomTargets(app: ConnectedApp, q: DomQuery): Promise<DomCollection> {
    return evaluateJson<DomCollection>(app.ws, buildDomCollectJs(q));
}

export async function prepareDomTarget(
    app: ConnectedApp,
    i: number
): Promise<{ x: number; y: number; scrolled: boolean; covered: string | null }> {
    const r = await evaluateJson<{ error?: string; x: number; y: number; scrolled: boolean; covered: string | null }>(
        app.ws,
        buildDomPrepareJs(i)
    );
    if (r.error) throw new Error(r.error);
    return r;
}

/** Lets a controlled input re-render, so a value React rejected has already reverted when it is read back. */
const READBACK_SETTLE_MS = 80;

export function buildDomFocusJs(i: number, replace: boolean, clearOnly: boolean): string {
    return `(function () {
    var el = (globalThis.__eb_domTargets || [])[${i}];
    if (!el || !el.isConnected) return JSON.stringify({ error: "The field left the page between lookup and write. Retry." });
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    var field = !el.isContentEditable;
    var before = field ? String(el.value) : el.innerText;
    if (field) {
        try {
            if (${replace}) el.select();
            else el.setSelectionRange(el.value.length, el.value.length);
        } catch (e) {}
    } else {
        var range = document.createRange();
        range.selectNodeContents(el);
        if (!${replace}) range.collapse(false);
        var sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    if (${clearOnly}) document.execCommand("delete");
    return JSON.stringify({
        before: before,
        field: field,
        focused: document.activeElement === el,
        maxLength: field && el.maxLength > 0 ? el.maxLength : null
    });
})()`;
}

export function buildDomReadJs(i: number): string {
    return `(function () {
    var el = (globalThis.__eb_domTargets || [])[${i}];
    if (!el || !el.isConnected) return JSON.stringify({ value: null });
    return JSON.stringify({ value: el.isContentEditable ? el.innerText : String(el.value) });
})()`;
}

export function judgeTextEntry(a: {
    before: string;
    sent: string;
    replace: boolean;
    landed: string | null;
    maxLength: number | null;
}): TextEntryResult {
    const expected = a.replace ? a.sent : a.before + a.sent;
    if (a.landed === expected) return { success: true, verified: true, value: a.landed, path: "cdp" };
    if (a.landed === null) return { success: false, error: "the field left the page before it could be read back", sent: expected, landed: null };
    const truncated = a.maxLength !== null && a.landed.length === a.maxLength && expected.startsWith(a.landed);
    return {
        success: false,
        error: truncated
            ? `the field's maxLength (${a.maxLength}) cut the text; retrying cannot fit it`
            : "the field does not hold what was sent (a controlled input may have rejected or reformatted it)",
        sent: expected,
        landed: a.landed,
    };
}

export async function chromiumInputText(
    app: ConnectedApp,
    a: { text: string; testID?: string; component?: string; textMatch?: string; index?: number; replace?: boolean }
): Promise<TextEntryResult> {
    const replace = a.replace === true;
    const targeted = a.testID !== undefined || a.component !== undefined || a.textMatch !== undefined;
    try {
        const found = await collectDomTargets(app, { mode: "input", testID: a.testID, component: a.component, textMatch: a.textMatch });
        const candidates = found.candidates.map((c, n) => ({
            index: n, component: c.tag, label: c.label, placeholder: c.placeholder, value: c.value, testID: c.testID,
        }));
        if (!targeted && !found.focused) {
            return {
                success: false,
                error: "no field is focused. Pass testID, component or textMatch so this tool can focus one itself.",
                candidates,
                totalInputs: found.total,
            };
        }
        const pick = pickDomTarget(found.candidates, undefined, a.index);
        if (pick.kind === "ambiguous") {
            return { success: false, ambiguous: true, error: `${pick.matches.length} fields match this target`, candidates, totalInputs: found.total };
        }
        if (pick.kind === "none") {
            return {
                success: false,
                error: "no visible editable field matches that target. On chromium, inputs, textareas and contenteditable elements are searched; " +
                    "testID matches data-testid / data-test-id / id.",
            };
        }
        const prep = await evaluateJson<{ error?: string; before: string; field: boolean; focused: boolean; maxLength: number | null }>(
            app.ws,
            buildDomFocusJs(pick.cand.i, replace, replace && a.text === "")
        );
        if (prep.error) return { success: false, error: prep.error };
        if (a.text !== "") await chromiumInsertText(app, a.text);
        await new Promise((r) => setTimeout(r, READBACK_SETTLE_MS));
        const { value } = await evaluateJson<{ value: string | null }>(app.ws, buildDomReadJs(pick.cand.i));
        // contenteditable innerText carries a trailing newline the caller never typed.
        const landed = value !== null && !prep.field ? value.replace(/\n$/, "") : value;
        return judgeTextEntry({ before: prep.before, sent: a.text, replace, landed, maxLength: prep.maxLength });
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
