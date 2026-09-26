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
    /** document.visibilityState is "hidden": a hidden window does not paint, so it cannot be captured. */
    hidden?: boolean;
}

/** Delivered-screenshot pixels per CSS pixel: devicePixelRatio, lowered only when the capture would exceed the cap. */
export function pxPerCss(vp: ChromiumViewport): number {
    const longest = Math.max(vp.w, vp.h);
    return longest * vp.dpr > CHROMIUM_MAX_DIMENSION ? CHROMIUM_MAX_DIMENSION / longest : vp.dpr;
}

export const VIEWPORT_JS =
    "JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hidden: document.visibilityState === \"hidden\" })";

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
    // Checked up front: Page.captureScreenshot on a hidden window never answers,
    // which cost the full capture timeout (verified on the FluentTalk popover).
    if (viewport.hidden) {
        throw new Error("The window is hidden (document.visibilityState is \"hidden\"), and a hidden window does not paint, so it cannot be captured. Show the window and retry.");
    }
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
    // Every field under a match, so a wrapper around several is reported as
    // ambiguous rather than resolved to whichever field comes first.
    function editablesIn(el) {
        if (isEditable(el)) return [el];
        var inner = el.querySelectorAll ? Array.prototype.slice.call(el.querySelectorAll("input, textarea, [contenteditable]")) : [];
        return inner.filter(isEditable);
    }
    function testIdOf(el) { return el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.id || null; }
    function labelOf(el) { return norm(el.getAttribute("aria-label") || (el.labels && el.labels[0] ? el.labels[0].innerText : "")) || null; }
    // A password never leaves the page (same rule as chromiumScreen's safeValue).
    function valueOf(el) {
        if (el.isContentEditable) return el.innerText;
        if (el.value == null) return null;
        return String(el.type).toLowerCase() === "password" ? (el.value ? "[password]" : "") : String(el.value);
    }
    function textOf(el) { return el.tagName === "INPUT" ? norm(valueOf(el) || el.getAttribute("aria-label")) : norm(el.innerText || el.getAttribute("aria-label")); }
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
            // valueOf, not el.value: matching by a password's value would make tap a guessing oracle.
            return norm(el.tagName === "INPUT" ? valueOf(el) : el.textContent).toLowerCase().indexOf(wantT) >= 0 ||
                norm(el.getAttribute("aria-label")).toLowerCase().indexOf(wantT) >= 0;
        });
        // Innermost first, visibility second: textContent includes hidden
        // descendants, so filtering visibility first let a visible container
        // stand in for a hidden match inside it.
        // els is in document order, where an element's descendants directly follow
        // it: if any descendant matched, the next match is one. O(k), not O(k^2).
        els = els.filter(function (el, n) { var next = els[n + 1]; return !(next && el.contains(next)); });
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
            els = els.reduce(function (acc, el) { return acc.concat(editablesIn(el)); }, [])
                .filter(function (el, n, a) { return a.indexOf(el) === n; });
        } else {
            var active = document.activeElement;
            focused = isEditable(active);
            els = focused ? [active] : all.filter(isEditable);
        }
    }
    els = els.filter(visible);
    globalThis.__eb_domTargets = els;
    return JSON.stringify({
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hidden: document.visibilityState === "hidden" },
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
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
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
    el.scrollIntoView({ block: "nearest", behavior: "instant" });
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
        maxLength: field && el.maxLength > 0 ? el.maxLength : null,
        password: field && String(el.type).toLowerCase() === "password"
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

const maskPw = (v: string) => `[password, ${v.length} chars]`;

/** A password write keeps its verdict, but none of its text reaches the transcript. */
export function maskPasswordEntry(r: TextEntryResult): TextEntryResult {
    return {
        ...r,
        ...(typeof r.value === "string" ? { value: maskPw(r.value) } : {}),
        ...(typeof r.sent === "string" ? { sent: maskPw(r.sent) } : {}),
        ...(typeof r.landed === "string" ? { landed: maskPw(r.landed) } : {}),
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
        const prep = await evaluateJson<{ error?: string; before: string; field: boolean; focused: boolean; maxLength: number | null; password: boolean }>(
            app.ws,
            buildDomFocusJs(pick.cand.i, replace, replace && a.text === "")
        );
        if (prep.error) return { success: false, error: prep.error };
        if (a.text !== "") await chromiumInsertText(app, a.text);
        await new Promise((r) => setTimeout(r, READBACK_SETTLE_MS));
        const { value } = await evaluateJson<{ value: string | null }>(app.ws, buildDomReadJs(pick.cand.i));
        // contenteditable innerText carries a trailing newline the caller never
        // typed, before the write (an empty editor reads "\n") as well as after.
        const trim = (v: string) => (prep.field ? v : v.replace(/\n$/, ""));
        const landed = value === null ? null : trim(value);
        const verdict = judgeTextEntry({ before: trim(prep.before), sent: a.text, replace, landed, maxLength: prep.maxLength });
        return prep.password ? maskPasswordEntry(verdict) : verdict;
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// ── Keys, wheel and drag ────────────────────────────────────────────────────

/** CDP Input modifiers bitmask. */
export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type ModName = keyof typeof MOD;

export interface KeyDef {
    /** DOM KeyboardEvent.key: "Enter", "ArrowUp", " ", "k". */
    key: string;
    code: string;
    /** Required: without it Enter does not submit a form. */
    windowsVirtualKeyCode: number;
    /** Sent on keyDown so the key fires keypress / input. */
    text?: string;
}

const MOD_KEYS: Record<ModName, KeyDef> = {
    Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
    Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
    Meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
    Shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

const MOD_ALIASES: Record<string, ModName> = {
    alt: "Alt", option: "Alt", opt: "Alt",
    control: "Control", ctrl: "Control",
    meta: "Meta", cmd: "Meta", command: "Meta",
    shift: "Shift",
};

const NAMED_KEYS: KeyDef[] = [
    { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
    ...Array.from({ length: 12 }, (_, i) => ({ key: `F${i + 1}`, code: `F${i + 1}`, windowsVirtualKeyCode: 112 + i })),
];

const KEY_ALIASES: Record<string, string> = {
    esc: "Escape", return: "Enter", space: " ", del: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

export const VALID_KEY_NAMES =
    "Enter, Escape, Tab, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F1-F12, " +
    "or a single character, optionally after modifiers joined by + (Shift, Control, Alt, Meta): e.g. Shift+Tab, Meta+K";

function charKey(ch: string): KeyDef {
    const lower = ch.toLowerCase();
    if (/^[a-z]$/.test(lower)) return { key: lower, code: `Key${lower.toUpperCase()}`, windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0), text: lower };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), text: ch };
    // ponytail: punctuation gets no code / virtual key; text alone types it. Add a table if a page keys on e.code.
    return { key: ch, code: "", windowsVirtualKeyCode: 0, text: ch };
}

/** "Shift+Tab", "meta+k", "Enter", "a" -> modifiers bitmask and one key. Case-insensitive. */
export function parseKeyCombo(input: string): { mods: number; key: KeyDef } | { error: string } {
    const s = input.trim();
    let keyPart: string;
    let modParts: string[];
    if (s === "+" || s.endsWith("++")) {
        keyPart = "+";
        modParts = s.length > 1 ? s.slice(0, -2).split("+") : [];
    } else {
        const parts = s.split("+");
        keyPart = parts.pop() ?? "";
        modParts = parts;
    }
    let mods = 0;
    for (const m of modParts) {
        const name = MOD_ALIASES[m.trim().toLowerCase()];
        if (!name) return { error: `Unknown modifier "${m}" in "${input}". Valid: ${VALID_KEY_NAMES}.` };
        mods |= MOD[name];
    }
    const k = keyPart.trim();
    const lower = k.toLowerCase();
    let key: KeyDef | undefined;
    if ([...k].length === 1) key = charKey(k);
    else {
        const want = (KEY_ALIASES[lower] ?? k).toLowerCase();
        key = NAMED_KEYS.find((d) => d.key.toLowerCase() === want || d.code.toLowerCase() === want);
    }
    if (!key) return { error: `Unknown key "${k || input}". Valid: ${VALID_KEY_NAMES}.` };
    // With Control, Alt or Meta held a key is a shortcut: text would type the letter into the field.
    if (mods & (MOD.Control | MOD.Alt | MOD.Meta)) key = { ...key, text: undefined };
    else if (mods & MOD.Shift && key.text && /^[a-z]$/.test(key.text)) key = { ...key, text: key.text.toUpperCase() };
    return { mods, key };
}

export type ScrollDirection = "up" | "down" | "left" | "right";

/** Wheel delta in CSS px. up reveals content below (+dy), left reveals content to the right (+dx), as a finger swipe does on mobile. */
export function wheelDelta(direction: ScrollDirection, distancePx: number | undefined, vp: ChromiumViewport): { dx: number; dy: number } {
    const vertical = direction === "up" || direction === "down";
    const css = distancePx && distancePx > 0 ? distancePx / pxPerCss(vp) : Math.round(0.33 * (vertical ? vp.h : vp.w));
    const sign = direction === "up" || direction === "left" ? 1 : -1;
    return vertical ? { dx: 0, dy: sign * css } : { dx: sign * css, dy: 0 };
}

/** Points from start to end at about 60 Hz, at least 5 steps, ending exactly on end. */
export function dragPath(
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number
): Array<{ x: number; y: number; at: number }> {
    const steps = Math.max(5, Math.round(durationMs / 16));
    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        return i === steps
            ? { ...end, at: durationMs }
            : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, at: durationMs * t };
    });
}

/** What SCROLL_PROBE_JS reads: the scroll container under a point and its offsets, CSS px. */
export type ScrollProbe =
    | { container: string; top: number; left: number; maxTop: number; maxLeft: number; page?: { top: number; left: number } }
    | { container: null };

/** How far the wheel moved the container on its axis (CSS px), and why not when it did not. */
export function scrollVerdict(
    before: ScrollProbe,
    after: ScrollProbe,
    delta: { dx: number; dy: number }
): { moved: number; chainedTo?: string; warning?: string } {
    if (before.container === null || after.container === null) {
        return { moved: 0, warning: "no scroll container under the point: nothing there scrolls. Aim startX/startY at the list itself (get_screen_state shows where it is)." };
    }
    const horizontal = Math.abs(delta.dx) > Math.abs(delta.dy);
    const pos = (p: typeof before) => (horizontal ? p.left : p.top);
    const max = horizontal ? before.maxLeft : before.maxTop;
    const moved = pos(after) - pos(before);
    if (Math.abs(moved) >= 1) return { moved };
    // The container was at its limit and the browser chained the wheel to the page.
    if (before.page && after.page) {
        const pageMoved = horizontal ? after.page.left - before.page.left : after.page.top - before.page.top;
        if (Math.abs(pageMoved) >= 1) return { moved: pageMoved, chainedTo: "the page" };
    }
    const where = before.container;
    if (max <= 0) {
        return { moved: 0, warning: `${where} is not scrollable ${horizontal ? "horizontally" : "vertically"}: its content fits, or it scrolls on the other axis. Swipe ${horizontal ? "up/down" : "left/right"} instead.` };
    }
    const towardEnd = (horizontal ? delta.dx : delta.dy) > 0;
    if (!towardEnd && pos(before) <= 1) return { moved: 0, warning: `${where} is already at the ${horizontal ? "start" : "top"}. Swipe the other direction to move.` };
    if (towardEnd && pos(before) >= max - 1) return { moved: 0, warning: `${where} is already at the end (offset ${Math.round(max)}). There is no more content this way.` };
    return { moved: 0, warning: `${where} is at ${Math.round(pos(before))} of ${Math.round(max)} and did not move: something under the pointer took the wheel (a map, a canvas), or scrolling is disabled.` };
}

type InputSend = (params: Record<string, unknown>) => Promise<unknown>;

/** One mouseWheel event at CSS (x, y): the browser scrolls whatever is under the pointer. */
export async function chromiumWheel(app: ConnectedApp, x: number, y: number, dx: number, dy: number): Promise<void> {
    await sendCdpCommand(app.ws, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
}

/** A left-button drag along path (CSS px), paced by each point's `at`. */
export async function chromiumDrag(app: ConnectedApp, path: Array<{ x: number; y: number; at: number }>): Promise<void> {
    const send: InputSend = (params) => sendCdpCommand(app.ws, "Input.dispatchMouseEvent", params);
    const [first, ...rest] = path;
    const last = path[path.length - 1];
    const t0 = Date.now();
    await send({ type: "mouseMoved", x: first.x, y: first.y });
    await send({ type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1 });
    for (const p of rest) {
        const wait = t0 + p.at - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await send({ type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
    }
    await send({ type: "mouseReleased", x: last.x, y: last.y, button: "left", buttons: 0, clickCount: 1 });
}

/**
 * Press one combo: each modifier goes down as its own key (so a keydown listener
 * sees Meta), then the key down and up, then the modifiers up in reverse.
 */
export async function chromiumKey(app: ConnectedApp, combo: { mods: number; key: KeyDef }): Promise<void> {
    const send: InputSend = (params) => sendCdpCommand(app.ws, "Input.dispatchKeyEvent", params);
    const held = (Object.keys(MOD) as ModName[]).filter((m) => combo.mods & MOD[m]);
    const fields = (d: KeyDef) => ({ key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode, nativeVirtualKeyCode: d.windowsVirtualKeyCode });
    let mods = 0;
    for (const m of held) {
        mods |= MOD[m];
        await send({ type: "rawKeyDown", modifiers: mods, ...fields(MOD_KEYS[m]) });
    }
    const k = combo.key;
    await send({ type: k.text ? "keyDown" : "rawKeyDown", modifiers: mods, ...fields(k), ...(k.text && { text: k.text, unmodifiedText: k.text }) });
    await send({ type: "keyUp", modifiers: mods, ...fields(k) });
    for (const m of held.reverse()) {
        mods &= ~MOD[m];
        await send({ type: "keyUp", modifiers: mods, ...fields(MOD_KEYS[m]) });
    }
}

/** Focus a collected target for press_key: the element itself if focusable, else the nearest focusable inside or around it. */
export function buildDomKeyFocusJs(i: number): string {
    return `(function () {
    var el = (globalThis.__eb_domTargets || [])[${i}];
    if (!el || !el.isConnected) return JSON.stringify({ error: "The element left the page between lookup and focus. Retry." });
    var F = "input, textarea, select, button, a[href], [tabindex], [contenteditable]";
    var f = el.matches(F) ? el : (el.querySelector(F) || el.closest(F));
    if (!f) return JSON.stringify({ error: "The target is not focusable and has no focusable element inside or around it, so keys cannot be sent to it." });
    f.scrollIntoView({ block: "nearest", behavior: "instant" });
    f.focus();
    // Caret at the end, so Backspace deletes what was typed last.
    if (typeof f.value === "string" && f.setSelectionRange) { try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) {} }
    return JSON.stringify({ focused: document.activeElement === f });
})()`;
}
