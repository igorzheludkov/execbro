import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";
import { iconSemanticHint } from "./iconSemantics.js";
import { VISIBILITY_HELPERS_JS, detectNativeSheet, NATIVE_SHEET_MARKER_RE_SRC } from "./injected/visibility.js";
import { RN_PRIMITIVES_SRC, GENERIC_COMPONENT_SRC } from "./injectedFilters.js";
import { SHEET_HELPERS_JS } from "./injected/sheetOffset.js";
import type { KeyboardState } from "./keyboardMetrics.js";

// ============================================================================
// Types matching the spec response shape
// ============================================================================

export interface ScreenStatePressable {
    label: string | null;
    /** Nearest custom component name (e.g. OrderStepRow, CheckBox) — greppable in the app codebase. */
    component?: string | null;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    testID: string | null;
    /** Icon child component name (e.g. SvgChevronBack) when the pressable has no text/a11y label. */
    icon?: string | null;
    /** True for TextInput-like elements (onChangeText/onFocus) — tap to focus, then type. */
    isInput?: boolean;
    /**
     * Current value of a Switch/Checkbox-like element (onValueChange). Absent on
     * everything else. Without it a settings row read as text at the label's
     * coordinates and the control itself was invisible, so the only way to flip
     * one was to guess an x from a screenshot.
     */
    switchValue?: boolean | null;
    /**
     * The input's current text, from props.value/defaultValue. Null when empty.
     * Kept separate from `inputPlaceholder` so a placeholder can never be read
     * as content — that misreading made every correct write look like a failure.
     */
    inputValue?: string | null;
    /** The input's placeholder. Rendered only when the field is actually empty. */
    inputPlaceholder?: string | null;
    /** Nearest standalone text (row sibling preferred) when the pressable has no label of its own. */
    nearbyText?: string | null;
    /** True when an overlay fully covers this root pressable — taps will not reach it. */
    blockedByOverlay?: boolean;
    /** What pressing triggers: "onPress=handleSubmit()", "onBack=goBack()", or "onPress→onBack" (prop route when the fn is anonymous). Absent when nothing meaningful survives Hermes. */
    onPressHint?: string | null;
    /**
     * Set when this element sits under a transform the layout tree does not include —
     * a sticky header, a collapsing toolbar, a sheet mid-animation. The frame is then
     * pre-transform: real geometry, wrong place. Absent means the frame is trustworthy.
     */
    transformNote?: string | null;
}

export interface ScreenStateText {
    text: string;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    blockedByOverlay?: boolean;
    transformNote?: string | null;
}

export interface ScreenStateImage {
    src?: string | null;
    alt?: string | null;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    blockedByOverlay?: boolean;
    transformNote?: string | null;
}

export interface ScreenStateOverlay {
    type: "BottomSheet" | "Modal" | "Alert" | "ActionSheet" | "Unknown";
    title: string | null;
    pressables: ScreenStatePressable[];
    texts?: ScreenStateText[];
    images?: ScreenStateImage[];
}

export interface ScreenStateNativeOverlay {
    kind: "sheet" | "unknown";
    component?: string;
    note: string;
}

export interface ScreenStateRoute {
    name: string;
    params: Record<string, unknown> | null;
    stack: string[];
}

export interface ScreenState {
    route: ScreenStateRoute | null;
    overlays: ScreenStateOverlay[];
    pressables: ScreenStatePressable[];
    texts: ScreenStateText[];
    images: ScreenStateImage[];
    nativeOverlay?: ScreenStateNativeOverlay | null;
    notes?: string[];
}

// ============================================================================
// Pure helpers (exported for unit tests)
// ============================================================================

export function markPressablesCoveredByOverlay(
    pressables: ScreenStatePressable[],
    overlayBounds: { x: number; y: number; width: number; height: number }
): ScreenStatePressable[] {
    for (const p of pressables) {
        const b = p.bounds;
        const fullyCovered =
            b.x >= overlayBounds.x &&
            b.y >= overlayBounds.y &&
            b.x + b.width <= overlayBounds.x + overlayBounds.width &&
            b.y + b.height <= overlayBounds.y + overlayBounds.height;
        if (fullyCovered) p.blockedByOverlay = true;
    }
    return pressables;
}

/** A count badge such as "1" or "99+" — the only "label" an icon button like a cart carries. */
const COUNT_BADGE_LABEL = /^\d{1,3}\+?$/;

/**
 * Replace component-name fallback labels with semantic icon labels when the
 * pressable's icon child name carries recognizable semantics:
 *   { label: "[FloatingHeader]", icon: "SvgChevronBackward" }
 *     → label "[SvgChevronBackward — possibly back button]"
 * An icon button whose only text is a count badge (cart with "1") keeps that
 * count as nearby context while the label is upgraded to the icon's meaning:
 *   { label: "1", icon: "SvgCartNew" } → label "[SvgCartNew — possibly cart button]", nearbyText "1"
 * Labels from text/a11y are never touched (icon is null for those).
 */
export function applyIconHintToLabel(p: ScreenStatePressable): ScreenStatePressable {
    if (!p.icon) return p;
    const hint = iconSemanticHint(p.icon);
    if (hint) {
        if (p.label && COUNT_BADGE_LABEL.test(p.label.trim()) && !p.nearbyText) {
            p.nearbyText = p.label;
        }
        p.label = `[${p.icon} — ${hint}]`;
    } else if (!p.label) {
        p.label = `[${p.icon}]`;
    }
    return p;
}

/**
 * Coordinate converter for any positioned item (pressable, text, image) — lets
 * screenshot tools map points/dp into screenshot pixels (including conditional
 * shifts like the iOS safe-area band). Reads only center/bounds, so it applies
 * uniformly across item types.
 */
export type ItemCoordConverter = (item: {
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
}) => {
    center: { x: number; y: number };
    frame: { x: number; y: number; width: number; height: number };
};
/** Alias kept for existing call sites; prefer ItemCoordConverter. */
export type PressableCoordConverter = ItemCoordConverter;

const identityCoords: ItemCoordConverter = (item) => ({ center: item.center, frame: item.bounds });

/** Stand-in when no keyboard state was read: nothing is blocked. */
const NO_KEYBOARD: KeyboardState = { visible: false, height: null, screenY: null, width: null };

const TEXT_DISPLAY_MAX = 80;
const IMAGE_SRC_DISPLAY_MAX = 60;

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + "…" : s;
}

/** One merged-list line for a static text node — coordinates match pressable lines. */
export function formatTextEntry(
    t: ScreenStateText,
    convert: ItemCoordConverter = identityCoords,
    opts: { fullText?: boolean } = {}
): string {
    const { center, frame } = convert(t);
    const body = opts.fullText ? t.text : truncate(t.text, TEXT_DISPLAY_MAX);
    return `  (${center.x}, ${center.y}) 📝 "${body}" frame:(${frame.x},${frame.y} ${frame.width}x${frame.height})${formatTransformTag(t)}`;
}

/** One merged-list line for an image node — coordinates match pressable lines. */
export function formatImageEntry(
    img: ScreenStateImage,
    convert: ItemCoordConverter = identityCoords
): string {
    const { center, frame } = convert(img);
    const src = img.src ? ` src="${truncate(img.src, IMAGE_SRC_DISPLAY_MAX)}"` : "";
    const alt = img.alt ? ` alt="${img.alt}"` : "";
    return `  (${center.x}, ${center.y}) 🖼 Image ${frame.width}x${frame.height}${src}${alt} frame:(${frame.x},${frame.y} ${frame.width}x${frame.height})${formatTransformTag(img)}`;
}

const TEXT_CAP = 60;
const IMAGE_CAP = 40;

/**
 * Render a ScreenState as the orientation summary used by get_screen_state and the
 * screenshot tools. By default it merges pressables, static text (📝), and images
 * (🖼) into one spatially-ordered list per reachability group — enough to read and
 * navigate the screen without a screenshot:
 *   📍 Detail  [Detail]
 *   🎯 Pressables:
 *     (210, 175) 🖼 Image 420x350 src="…"
 *     (146, 394) 📝 "Valya product" frame:(20,382 251x24)
 *     (210, 838) <Button /> "In cart" frame:(20,810 380x56)
 * pressablesOnly restores the lean pressable-only snapshot; fullText disables the
 * 80-char text truncation.
 */
/**
 * One line describing the keyboard, or "" when it is down and known to be.
 *
 * The point is layout validation: a raised keyboard shrinks the usable area,
 * and that is exactly when bottom-anchored UI misbehaves. Reporting the height
 * and the remaining content area makes that inspectable without a screenshot.
 */
export function formatKeyboardLine(k: KeyboardState, pixelScale: number = 1): string {
    if (k.error) return `⌨️ Keyboard: unknown (${k.error})`;
    if (!k.visible || k.height == null || k.screenY == null) return "";
    // Reported in the same delivered-pixel space as every coordinate around it. The
    // keyboard's screenY is a y a reader compares against element positions, so leaving
    // it in points while the element list moved to pixels would invite exactly the
    // cross-space comparison this unification exists to remove.
    const s = pixelScale > 0 ? pixelScale : 1;
    // Android reports fractional dp (288.3809509277344); whole units are what a reader
    // can act on, and the sub-pixel tail only obscures the number.
    const r = (n: number) => Math.round(n * s);
    const unit = s === 1 ? "pt" : "px";
    const width = k.width != null ? `${r(k.width)}x` : "";
    return `⌨️ Keyboard: visible, ${r(k.height)}${unit} — content area above it ${width}${r(k.screenY)}${unit}`;
}

/**
 * Splits elements the keyboard covers from those still reachable.
 *
 * Mirrors the existing overlay handling rather than inventing a second notion
 * of "blocked": an element under the keyboard cannot be tapped, for the same
 * reason and with the same consequence as one under a sheet.
 */
export function partitionByKeyboard<T extends { center: { x: number; y: number } }>(
    items: T[],
    k: KeyboardState
): { reachable: T[]; blocked: T[] } {
    if (!k.visible || k.screenY == null) return { reachable: items, blocked: [] };
    const reachable: T[] = [];
    const blocked: T[] = [];
    for (const item of items) {
        (item.center.y >= k.screenY ? blocked : reachable).push(item);
    }
    return { reachable, blocked };
}

/**
 * Renders an input's state so the value is unmistakably the value and the
 * placeholder is unmistakably a placeholder. Returns "" for non-inputs.
 */
/** " [switch:ON]" for a Switch-like element; "" for everything else. */
export function formatSwitchState(p: ScreenStatePressable): string {
    if (p.switchValue === undefined || p.switchValue === null) return "";
    return ` [switch:${p.switchValue ? "ON" : "OFF"}]`;
}

export function formatInputState(p: ScreenStatePressable): string {
    if (!p.isInput) return "";
    if (p.inputValue) return ` [input] value:${JSON.stringify(p.inputValue)}`;
    // inputValue/inputPlaceholder are absent on entries captured before this
    // field existed (or by other producers); fall back to the bare marker
    // rather than asserting the field is empty.
    if (p.inputValue === undefined && p.inputPlaceholder === undefined) return " [input]";
    return p.inputPlaceholder
        ? ` [input] empty, placeholder:${JSON.stringify(p.inputPlaceholder)}`
        : " [input] empty";
}

/**
 * Route params, one line. Keys always; values only when asked for.
 *
 * The full blob used to print on every screenshot and every screen-state call —
 * hundreds of characters of image URLs and ids, per call, dozens of times a
 * session, and read approximately never. Knowing *which* params exist is what
 * actually orients you; the values are a lookup you can ask for.
 */
export function formatRouteParams(
    params: Record<string, unknown> | null | undefined,
    fullParams: boolean
): string | null {
    if (!params) return null;
    const keys = Object.keys(params);
    if (keys.length === 0) return null;
    if (!fullParams) {
        return `   route params: ${keys.join(", ")}  (values: fullParams=true)`;
    }
    const json = JSON.stringify(params);
    return `   route params: ${json.length > 600 ? json.slice(0, 600) + "…" : json}`;
}

/**
 * The tag that stops a pre-transform frame being read as a tap target.
 *
 * Deliberately inline on the element's own line rather than only in a footnote — the
 * coordinates and the warning about them have to travel together, because the coordinates
 * are what gets copied into the next tap().
 */
export function formatTransformTag(el: { transformNote?: string | null }): string {
    if (!el.transformNote) return "";
    return `  ⚠transformed(${el.transformNote}) — frame is pre-transform, verify before tapping`;
}

export function formatScreenStateSummary(
    ss: ScreenState,
    convert: ItemCoordConverter = identityCoords,
    opts: {
        pressablesOnly?: boolean;
        fullText?: boolean;
        fullParams?: boolean;
        keyboard?: KeyboardState;
        pixelScale?: number;
    } = {}
): string {
    const lines: string[] = [];
    if (ss.route) {
        lines.push(`📍 Currently focused screen: "${ss.route.name}"  [navigation stack: ${ss.route.stack.join(" > ")}]`);
        const paramLine = formatRouteParams(ss.route.params, opts.fullParams === true);
        if (paramLine) lines.push(paramLine);
    } else {
        lines.push("📍 Currently focused screen: unknown (no React Navigation / Expo Router detected)");
    }
    if (opts.keyboard) {
        const kbLine = formatKeyboardLine(opts.keyboard, opts.pixelScale);
        if (kbLine) lines.push(kbLine);
    }
    if (ss.nativeOverlay) {
        const comp = ss.nativeOverlay.component ? ` (${ss.nativeOverlay.component})` : "";
        lines.push(
            `⚠️ Native sheet detected${comp} — its content is presented outside the RN coordinate ` +
            `space, so tap targets below may be wrong. Verify with ios_screenshot / ocr_screenshot.`
        );
    }
    if (ss.notes && ss.notes.length > 0) {
        for (const n of ss.notes) lines.push(`ℹ️ ${n}`);
    }
    const formatPressable = (p: ScreenStatePressable) => {
        const { center, frame } = convert(p);
        // 🔘 marks tap targets in the enriched view (where 📝 text / 🖼 images also
        // appear); omitted under pressablesOnly to keep the lean legacy lines.
        const marker = opts.pressablesOnly ? "" : " 🔘";
        return `  (${center.x}, ${center.y})${marker}${p.component ? ` <${p.component} />` : ""} ${p.label ? `"${p.label}"` : "(unlabeled)"}` +
            `${p.nearbyText ? ` near "${p.nearbyText}"` : ""}${p.onPressHint ? ` ${p.onPressHint}` : ""}` +
            `${p.testID ? ` testID="${p.testID}"` : ""}${formatInputState(p)}${formatSwitchState(p)}` +
            ` frame:(${frame.x},${frame.y} ${frame.width}x${frame.height})${formatTransformTag(p)}`;
    };

    // Merge pressables + (unless pressablesOnly) texts + images for one reachability
    // group, sorted spatially (top→bottom, then left→right). A text duplicating a
    // pressable's nearbyText is dropped; texts/images cap with an explicit marker.
    const renderGroup = (
        pressables: ScreenStatePressable[],
        texts: ScreenStateText[],
        images: ScreenStateImage[]
    ): string[] => {
        const out: string[] = [];
        const nearby = new Set(pressables.map((p) => (p.nearbyText || "").trim()).filter(Boolean));
        const freshTexts = opts.pressablesOnly ? [] : texts.filter((t) => !nearby.has(t.text.trim()));
        const useTexts = freshTexts.slice(0, TEXT_CAP);
        const useImages = opts.pressablesOnly ? [] : images.slice(0, IMAGE_CAP);
        type Row = { y: number; x: number; line: string };
        const rows: Row[] = [
            ...pressables.map((p) => ({ y: p.center.y, x: p.center.x, line: formatPressable(p) })),
            ...useTexts.map((t) => ({ y: t.center.y, x: t.center.x, line: formatTextEntry(t, convert, opts) })),
            ...useImages.map((img) => ({ y: img.center.y, x: img.center.x, line: formatImageEntry(img, convert) })),
        ];
        rows.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
        rows.forEach((r) => out.push(r.line));
        if (!opts.pressablesOnly) {
            const droppedT = freshTexts.length - useTexts.length;
            const droppedI = images.length - useImages.length;
            if (droppedT > 0) out.push(`  … +${droppedT} more text`);
            if (droppedI > 0) out.push(`  … +${droppedI} more images`);
        }
        return out;
    };

    // A native sheet has no entry in ss.overlays (it's not in the fiber-measured tree), but
    // it flags the underlying pressables blockedByOverlay — so take the split reachable/blocked
    // path even when overlays is empty, so those flags surface in the summary.
    if (ss.overlays.length > 0 || ss.nativeOverlay) {
        for (const overlay of ss.overlays) {
            lines.push(`\n🔲 ${overlay.type}${overlay.title ? ` — "${overlay.title}"` : ""}:`);
            const body = renderGroup(overlay.pressables, overlay.texts ?? [], overlay.images ?? []);
            if (body.length > 0) body.forEach((l) => lines.push(l));
            else lines.push("  (no pressables)");
        }
        const reachableP = ss.pressables.filter((p) => !p.blockedByOverlay);
        const blockedP = ss.pressables.filter((p) => p.blockedByOverlay);
        const reachableT = ss.texts.filter((t) => !t.blockedByOverlay);
        const blockedT = ss.texts.filter((t) => t.blockedByOverlay);
        const reachableI = ss.images.filter((i) => !i.blockedByOverlay);
        const blockedI = ss.images.filter((i) => i.blockedByOverlay);
        const rootBody = renderGroup(reachableP, reachableT, reachableI);
        if (opts.pressablesOnly) {
            lines.push(`\n🎯 Root pressables: ${reachableP.length > 0 ? "" : "(none reachable)"}`);
        } else {
            lines.push(`\n🎯 Reachable (outside any overlay):${rootBody.length > 0 ? "" : " (nothing reachable)"}`);
        }
        rootBody.forEach((l) => lines.push(l));
        if (blockedP.length > 0 || blockedT.length > 0 || blockedI.length > 0) {
            lines.push(`\n🚫 Blocked by overlay (visible on the underlying screen but taps will NOT reach them until the overlay closes):`);
            renderGroup(blockedP, blockedT, blockedI).forEach((l) => lines.push(l));
        }
    } else {
        // A raised keyboard blocks taps exactly as an overlay does, so it gets
        // the same treatment rather than a second notion of "blocked".
        const kb = opts.keyboard;
        const splitP = partitionByKeyboard(ss.pressables, kb ?? NO_KEYBOARD);
        const splitT = partitionByKeyboard(ss.texts, kb ?? NO_KEYBOARD);
        const splitI = partitionByKeyboard(ss.images, kb ?? NO_KEYBOARD);

        lines.push(opts.pressablesOnly ? "\n🎯 Pressables:" : "\n🎯 On screen:");
        const body = renderGroup(splitP.reachable, splitT.reachable, splitI.reachable);
        if (body.length > 0) body.forEach((l) => lines.push(l));
        else lines.push("  (none)");

        if (splitP.blocked.length > 0 || splitT.blocked.length > 0 || splitI.blocked.length > 0) {
            lines.push(
                "\n🚫 Blocked by keyboard (behind the raised keyboard — taps will NOT reach them until it is dismissed):"
            );
            renderGroup(splitP.blocked, splitT.blocked, splitI.blocked).forEach((l) => lines.push(l));
        }
    }
    return lines.join("\n");
}

/**
 * Turn raw onPress handler info ({ n: fn.name, s: source head }) into a
 * displayable hint, or null when nothing meaningful survives:
 * - real names ("handleSubmit", "bound goBack") → "handleSubmit()" / "goBack()"
 * - generic/minified names ("onPress", "anonymous", "t12") are rejected
 * - anonymous with retained source → "{() => setAccepted(prev => !prev)…}"
 * - Hermes bytecode bundles (source = "[bytecode]", stripped in-app) → null
 */
const GENERIC_HANDLER_NAMES = new Set(["", "anonymous", "onpress", "onclick", "handler", "callback", "fn", "press", "value"]);

function meaningfulHandlerName(n: string | undefined): string | null {
    let name = (n || "").trim();
    if (name.startsWith("bound ")) name = name.slice(6).trim();
    if (!name || GENERIC_HANDLER_NAMES.has(name.toLowerCase())) return null;
    if (/^[a-zA-Z_$]\d{1,4}$/.test(name) || name.length === 1) return null; // minified (t12, e)
    return name;
}

export function describePressHandler(raw: unknown): string | null {
    if (!raw || typeof raw !== "object") return null;
    const { n, s } = raw as { n?: string; s?: string };
    const name = meaningfulHandlerName(n);
    if (name) return `${name}()`;
    const src = (s || "").trim();
    if (src) return `{${src.length > 70 ? src.slice(0, 70) + "…" : src}}`;
    return null;
}

/**
 * Fallback handler context from the custom component's on* props, for when the
 * direct onPress is anonymous (Hermes discards source even in dev bundles, and
 * names like navigation.goBack are lost to computed assignment):
 * - only trust the prop whose value IS the touchable's onPress (pass-through);
 *   a non-matched candidate is an unverifiable guess that mislabels every button
 *   in a multi-button container (FloatingHeader exposes only onBack, but its menu
 *   and cart buttons run internal handlers) — so it yields null
 * - named fn → "onBack=goBack()"; nameless → "onPress→onBack" (the prop name
 *   alone is greppable context); a bare nameless "onPress" prop adds nothing → null
 */
export function describePropHandlers(raw: unknown): string | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    type Entry = { p?: string; n?: string; same?: boolean };
    const entries = raw.filter((e): e is Entry & { p: string } =>
        !!e && typeof e === "object" && typeof (e as Entry).p === "string");
    const pick = entries.find((e) => e.same) ?? null;
    if (!pick) return null;
    const name = meaningfulHandlerName(pick.n);
    if (name) return `${pick.p}=${name}()`;
    if (pick.p.toLowerCase() === "onpress") return null;
    return `onPress→${pick.p}`;
}

export function parseScreenStateResponse(raw: unknown): ScreenState | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.error) return null;
    return {
        route: (r.route as ScreenStateRoute | null) ?? null,
        overlays: (r.overlays as ScreenStateOverlay[]) ?? [],
        pressables: (r.pressables as ScreenStatePressable[]) ?? [],
        texts: (r.texts as ScreenStateText[]) ?? [],
        images: (r.images as ScreenStateImage[]) ?? [],
        nativeOverlay: (r.nativeOverlay as ScreenStateNativeOverlay | null) ?? null,
        notes: (r.notes as string[]) ?? [],
    };
}

// ============================================================================
// Main function (dispatch phase — Task 3; resolve phase added in Task 4)
// ============================================================================

export async function getScreenState(
    options: { device?: string } = {}
): Promise<ExecutionResult & { screenState?: ScreenState }> {
    const { device } = options;

    const dispatchExpression = `
(function() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return { error: 'React DevTools hook not found.' };

    var roots = [];
    if (hook.getFiberRoots) roots = Array.from(hook.getFiberRoots(1) || []);
    if (roots.length === 0 && hook.renderers) {
        for (var entry of hook.renderers) {
            var r = Array.from(hook.getFiberRoots ? (hook.getFiberRoots(entry[0]) || []) : []);
            if (r.length > 0) { roots = r; break; }
        }
    }
    if (roots.length === 0) return { error: 'No fiber roots found.' };

    // ------------------------------------------------------------------
    // Shared utilities
    // ------------------------------------------------------------------

    function getComponentName(fiber) {
        if (!fiber || !fiber.type) return null;
        if (typeof fiber.type === 'string') return fiber.type;
        return fiber.type.displayName || fiber.type.name || null;
    }

    ${VISIBILITY_HELPERS_JS}
    ${SHEET_HELPERS_JS}

    function getMeasurable(fiber) {
        var sn = fiber.stateNode;
        if (!sn) return null;
        if (typeof sn.measureInWindow === 'function') return sn;
        if (sn.canonical && sn.canonical.publicInstance &&
            typeof sn.canonical.publicInstance.measureInWindow === 'function') {
            return sn.canonical.publicInstance;
        }
        if (sn.node && globalThis.nativeFabricUIManager &&
            typeof globalThis.nativeFabricUIManager.measureInWindow === 'function') {
            var node = sn.node;
            return {
                measureInWindow: function(cb) {
                    try { globalThis.nativeFabricUIManager.measureInWindow(node, cb); } catch(e) {}
                }
            };
        }
        return null;
    }

    function findFirstHost(fiber, depth) {
        if (!fiber || depth > 20) return null;
        if (typeof fiber.type === 'string' && getMeasurable(fiber)) return fiber;
        var child = fiber.child;
        while (child) {
            var found = findFirstHost(child, depth + 1);
            if (found) return found;
            child = child.sibling;
        }
        return null;
    }

    function findHostsInSubtree(fiber, depth, hosts, limit) {
        if (!fiber || depth > 20 || hosts.length >= limit) return;
        if (typeof fiber.type === 'string' && getMeasurable(fiber)) {
            hosts.push(fiber);
            return;
        }
        var child = fiber.child;
        while (child && hosts.length < limit) {
            findHostsInSubtree(child, depth + 1, hosts, limit);
            child = child.sibling;
        }
    }

    function collectText(fiber, d) {
        if (!fiber || d > 20) return '';
        var props = fiber.memoizedProps;
        // Host text fibers carry the raw string as memoizedProps — needed when a
        // mixed-children Text falls through to the fiber-child walk below.
        if (typeof props === 'string') return props;
        if (typeof props === 'number') return String(props);
        if (props) {
            var ch = props.children;
            if (typeof ch === 'string') return ch;
            if (typeof ch === 'number') return String(ch);
            if (Array.isArray(ch)) {
                var inline = [];
                var hasElement = false;
                for (var ci = 0; ci < ch.length; ci++) {
                    if (typeof ch[ci] === 'string') inline.push(ch[ci]);
                    else if (typeof ch[ci] === 'number') inline.push(String(ch[ci]));
                    else if (ch[ci] != null && ch[ci] !== false) hasElement = true;
                }
                // Mixed content ("Create " + <Text>2 digital items</Text>): fall through
                // to the fiber-child walk so nested Text elements are included; the host
                // text fibers re-supply the inline strings, so nothing is lost or doubled.
                if (inline.length > 0 && !hasElement) return inline.join('');
            }
        }
        var parts = [];
        var child = fiber.child;
        while (child) {
            var t = collectText(child, d + 1);
            if (t) parts.push(t);
            child = child.sibling;
        }
        return parts.join(' ').replace(/\\s+/g, ' ').trim();
    }

    // ------------------------------------------------------------------
    // 1. Route detection
    // ------------------------------------------------------------------

    var route = null;

    // SDK navigation ref (highest priority — works even when NavigationContainer is wrapped)
    try {
        var sdk = globalThis.__EXECBRO__ || globalThis.__RN_AI_DEVTOOLS__;
        var sdkNav = sdk && sdk.navigation;
        if (sdkNav && typeof sdkNav.getCurrentRoute === 'function') {
            var currentRoute = sdkNav.getCurrentRoute();
            var rootState = typeof sdkNav.getRootState === 'function' ? sdkNav.getRootState() : null;
            if (currentRoute && currentRoute.name) {
                var sdkStack = [];
                if (rootState && rootState.routes) {
                    (function collectStack(state) {
                        if (!state || !state.routes) return;
                        var idx = typeof state.index === 'number' ? state.index : state.routes.length - 1;
                        if (state.type === 'stack') {
                            // show full stack history for stack navigators
                            for (var i = 0; i < state.routes.length; i++) {
                                sdkStack.push(state.routes[i].name || state.routes[i].key || 'unknown');
                            }
                            var focused = state.routes[idx];
                            if (focused && focused.state) collectStack(focused.state);
                        } else {
                            // for tab/drawer just follow the focused screen
                            var focused = state.routes[idx];
                            if (focused) {
                                sdkStack.push(focused.name || focused.key || 'unknown');
                                if (focused.state) collectStack(focused.state);
                            }
                        }
                    })(rootState);
                }
                if (sdkStack.length === 0) sdkStack.push(currentRoute.name);
                route = {
                    name: currentRoute.name,
                    params: currentRoute.params || null,
                    stack: sdkStack
                };
            }
        }
    } catch(e) {}

    if (!route) try {
        // React Navigation v5+: walk fiber tree for NavigationContainer ref
        function findNavState(fiber, depth) {
            if (!fiber || depth > 200) return null;
            var name = getComponentName(fiber);
            // NavigationContainer stores ref on stateNode; check state
            if (name === 'NavigationContainer' || name === 'BaseNavigationContainer') {
                var sn = fiber.stateNode;
                if (sn && typeof sn.getRootState === 'function') {
                    return sn.getRootState();
                }
                // Hook-based: memoizedState chain
                var mState = fiber.memoizedState;
                while (mState) {
                    if (mState.memoizedState && mState.memoizedState.routes) {
                        return mState.memoizedState;
                    }
                    mState = mState.next;
                }
            }
            var child = fiber.child;
            while (child) {
                var r = findNavState(child, depth + 1);
                if (r) return r;
                child = child.sibling;
            }
            return null;
        }

        // Also try __reactNavigationContainerRef global
        var navState = null;
        if (globalThis.__reactNavigationContainerRef && globalThis.__reactNavigationContainerRef.current) {
            var ref = globalThis.__reactNavigationContainerRef.current;
            if (typeof ref.getState === 'function') navState = ref.getState();
        }
        if (!navState) navState = findNavState(roots[0].current, 0);

        // Fallback: scan all fibers for memoizedState with navigation shape
        // (catches anonymous BaseNavigationContainer when displayName/name is null)
        if (!navState) {
            function isNavState(v) {
                return v && typeof v === 'object' && Array.isArray(v.routes) && v.routes.length > 0
                    && typeof v.routes[0].name === 'string' && typeof v.index === 'number';
            }
            function findNavStateByShape(fiber, depth) {
                if (!fiber || depth > 400) return null;
                var s = fiber.memoizedState;
                var checked = 0;
                while (s && checked < 20) {
                    if (isNavState(s.memoizedState)) return s.memoizedState;
                    s = s.next;
                    checked++;
                }
                var result = findNavStateByShape(fiber.child, depth + 1);
                if (result) return result;
                return findNavStateByShape(fiber.sibling, depth + 1);
            }
            navState = findNavStateByShape(roots[0].current, 0);
        }

        // Last resort: React Navigation exposes the root state on a context provider's
        // value, not on a hook's memoizedState. With createStaticNavigation the container
        // fiber is anonymous (no displayName) and nothing nav-shaped ever reaches
        // memoizedState, so every strategy above misses and the tool reports "no React
        // Navigation detected" on an app that plainly has it.
        //
        // Measured across three apps: this provider is present in all of them (depth 20-40),
        // while the memoizedState shape exists only under dynamic config / expo-router.
        // That makes it the one location covering static config, dynamic config and
        // expo-router alike. Kept last so the cheaper strategies still win when they work.
        if (!navState) {
            function findNavStateByProviderValue(fiber, depth) {
                if (!fiber || depth > 400) return null;
                var p = fiber.memoizedProps;
                if (p && p.value && typeof p.value === 'object') {
                    try {
                        if (typeof p.value.getRootState === 'function') {
                            var rs = p.value.getRootState();
                            if (isNavState(rs)) return rs;
                        }
                    } catch (e) {}
                }
                var result = findNavStateByProviderValue(fiber.child, depth + 1);
                if (result) return result;
                return findNavStateByProviderValue(fiber.sibling, depth + 1);
            }
            navState = findNavStateByProviderValue(roots[0].current, 0);
        }

        if (navState && navState.routes) {
            var fiberStack = [];
            var fiberLeafParams = null;
            (function collectFiberStack(state) {
                if (!state || !state.routes || state.routes.length === 0) return;
                var idx = (typeof state.index === 'number') ? state.index : state.routes.length - 1;
                if (state.type === 'stack' || !state.type) {
                    for (var i = 0; i < state.routes.length; i++) {
                        fiberStack.push(state.routes[i].name || state.routes[i].key || 'unknown');
                    }
                    var focused = state.routes[idx];
                    if (focused) {
                        fiberLeafParams = focused.params || null;
                        if (focused.state) collectFiberStack(focused.state);
                    }
                } else {
                    var focused = state.routes[idx];
                    if (focused) {
                        fiberStack.push(focused.name || focused.key || 'unknown');
                        fiberLeafParams = focused.params || null;
                        if (focused.state) collectFiberStack(focused.state);
                    }
                }
            })(navState);
            if (fiberStack.length > 0) {
                route = {
                    name: fiberStack[fiberStack.length - 1],
                    params: fiberLeafParams,
                    stack: fiberStack
                };
            }
        }
    } catch(e) {}

    // ------------------------------------------------------------------
    // 2. Overlay detection — build bounds for each overlay
    // ------------------------------------------------------------------

    var OVERLAY_NAMES = /^(Modal|BottomSheet|BottomSheetModal|BottomSheetView|ActionSheet|Alert)$/;
    // react-native-screens native-stack presentations that opaquely cover the screens
    // beneath them. transparentModal / containedTransparentModal are excluded — the
    // underlying screen genuinely shows through, so its elements stay reachable.
    var COVERING_PRESENTATIONS = /^(modal|fullScreenModal|containedModal|formSheet)$/;
    var overlayFiberMeta = []; // { type, fiberRoot, hostFibers }

    function classifyOverlay(name) {
        if (name === 'Modal') return 'Modal';
        if (name === 'Alert') return 'Alert';
        if (/ActionSheet/i.test(name)) return 'ActionSheet';
        if (/BottomSheet/i.test(name)) return 'BottomSheet';
        return 'Unknown';
    }

    // style can be an object, a nested array, or null. Only the flattened result can be
    // asked about position/backgroundColor, and the previous heuristic read the raw prop —
    // so any component passing style={[base, override]} was silently skipped.
    function flattenStyle(s) {
        if (!s) return null;
        if (Array.isArray(s)) {
            var out = null;
            for (var fi = 0; fi < s.length; fi++) {
                var f = flattenStyle(s[fi]);
                if (!f) continue;
                if (!out) out = {};
                for (var k in f) out[k] = f[k];
            }
            return out;
        }
        if (typeof s !== 'object') return null;
        // Copy rather than return the prop as-is. A Reanimated animated style
        // throws ReanimatedError("Perhaps you are trying to pass an animated
        // style to a non-animated component") from its own property getters, so
        // handing it back would move the throw into every caller that reads
        // .zIndex / .position — which aborted the whole traversal and returned
        // nothing for a screen a screenshot could read fine.
        var copy = {};
        try {
            for (var ck in s) copy[ck] = s[ck];
        } catch (e) {
            return null;
        }
        return copy;
    }

    // RN's own sticky-header implementation. It leaves the header at its natural layout
    // position — far above the viewport once the list is scrolled — and pins it purely with
    // translateY, so its measured frame is never where it is drawn. An exact marker, unlike
    // "is animated", which is true of half the tab bars in existence.
    var STICKY_OWNER = /^ScrollViewStickyHeader$/;

    /** The current value of an Animated node, or null when it is not one / cannot be read. */
    function animatedValueOf(v) {
        if (!v || typeof v !== 'object') return null;
        if (typeof v.__getValue !== 'function') return null;
        try {
            var got = v.__getValue();
            return typeof got === 'number' && isFinite(got) ? got : null;
        } catch (e) { return null; }
    }

    /** True for an Animated node handed to the native driver, whose JS value may be stale. */
    function isNativeDriven(v) {
        return !!(v && typeof v === 'object' && v.__isNative === true);
    }

    /**
     * Resolve the transform chain above this fiber, up to the fiber root.
     *
     * Returns null when there is no transform at all, else { dx, dy, uncertain, label }:
     * dx/dy are the best available composed translation, and the uncertain flag says
     * whether that number can be trusted.
     *
     * The hard case is a native-driven transform. measureInWindow and getBoundingClientRect
     * both read the shadow tree, so neither sees one — verified on RN 0.83/Fabric, where a
     * pinned sticky header sat at y=132pt on screen while both APIs reported y=-1698pt. The
     * JS-side style holds whatever was last committed, which for that header is translateY:0
     * forever. So there is no way to be exactly right; the goal is to be exactly honest.
     *
     * Reading Animated nodes with __getValue() is what keeps this quiet enough to be worth
     * reading: a resting tab bar composes to 0 and says nothing, instead of tagging every
     * tab item on every screen and training the reader to ignore the tag.
     */
    function transformStateOf(fiber) {
        var dx = 0, dy = 0;
        var uncertain = false;
        var sticky = false;
        var label = null;
        var sawTransform = false;
        var cur = fiber;
        var steps = 0;
        while (cur && steps < 30) {
            var ownerName = getComponentName(cur);
            if (ownerName && STICKY_OWNER.test(ownerName)) sticky = true;

            var st = flattenStyle(cur.memoizedProps && cur.memoizedProps.style);
            var t = st && st.transform;
            if (t) {
                sawTransform = true;
                if (Array.isArray(t)) {
                    for (var i = 0; i < t.length; i++) {
                        var op = t[i];
                        if (!op || typeof op !== 'object') continue;
                        for (var key in op) {
                            var raw = op[key];
                            var val = typeof raw === 'number' && isFinite(raw) ? raw : animatedValueOf(raw);
                            if (val === null) {
                                // An opaque value: not a number and not a readable node.
                                uncertain = true;
                                if (!label) label = key + ':<unreadable>';
                                continue;
                            }
                            if (isNativeDriven(raw)) uncertain = true;
                            if (key === 'translateX') {
                                dx += val;
                                if (!label && val !== 0) label = 'translateX:' + val;
                            } else if (key === 'translateY') {
                                dy += val;
                                if (!label && val !== 0) label = 'translateY:' + val;
                            } else if (val !== 0 && !(key === 'scale' && val === 1) &&
                                       !(key === 'scaleX' && val === 1) && !(key === 'scaleY' && val === 1)) {
                                // scale / rotate / skew / matrix at a non-identity value: a real
                                // geometric effect this does not model. Say so rather than
                                // presenting the untouched frame as exact.
                                uncertain = true;
                                if (!label) label = key + ':' + val;
                            }
                        }
                    }
                } else {
                    uncertain = true;
                    if (!label) label = 'transform:<opaque>';
                }
            }
            cur = cur.return;
            steps++;
        }
        if (sticky && sawTransform) {
            uncertain = true;
            label = 'sticky header';
        }
        if (!sawTransform) return null;
        return { dx: dx, dy: dy, uncertain: uncertain, label: label || 'transformed' };
    }

    // "Opaque enough to hide what is behind it." Colours reach the fiber either as CSS
    // strings or, on Fabric, as processed ARGB integers; both carry the alpha that decides
    // whether this is a cover or just a tint. A translucent scrim is deliberately NOT a
    // cover — the screen shows through it and its elements stay readable.
    function isOpaqueBackground(st) {
        if (st.opacity != null && st.opacity < 0.95) return false;
        var bg = st.backgroundColor;
        if (bg == null) return false;
        if (typeof bg === 'number') return ((bg >>> 24) & 255) >= 242;
        if (typeof bg !== 'string') return false;
        var v = bg.replace(/\\s/g, '').toLowerCase();
        if (v === 'transparent') return false;
        var m = v.match(/^rgba\\(([^)]*)\\)$/);
        if (m) {
            var parts = m[1].split(',');
            if (parts.length === 4 && parseFloat(parts[3]) < 0.95) return false;
        }
        if (v.charAt(0) === '#' && (v.length === 9 || v.length === 5)) {
            var hex = v.length === 9 ? v.slice(7, 9) : (v.charAt(4) + v.charAt(4));
            var alpha = parseInt(hex, 16);
            if (!isNaN(alpha) && alpha < 242) return false;
        }
        return true;
    }

    // The opaque surface is usually NOT on the positioned node. The common shape is a
    // transparent absolutely-positioned wrapper whose child paints the panel — a bottom
    // sheet is typically an absolute View wrapping an inner (often animated) View that
    // carries the opaque backgroundColor. Inspecting only the wrapper's own style (the
    // first version of this rule) therefore recognises almost no real sheet.
    function hasOpaqueSurface(fiber, ownStyle) {
        // A wrapper that is itself faded out is not covering anything, whatever its
        // children declare.
        if (ownStyle && ownStyle.opacity != null && ownStyle.opacity < 0.95) return false;
        if (ownStyle && isOpaqueBackground(ownStyle)) return true;
        var found = false;
        (function scan(n, d) {
            if (!n || d > 4 || found) return;
            if (typeof n.type === 'string') {
                var st = flattenStyle(n.memoizedProps && n.memoizedProps.style);
                if (st && isOpaqueBackground(st)) { found = true; return; }
            }
            scan(n.child, d + 1);
            if (!found) scan(n.sibling, d);
        })(fiber.child, 0);
        return found;
    }

    function hasPressableDescendant(f) {
        var found = false;
        (function scan(n, d) {
            if (!n || d > 12 || found) return;
            if (n.memoizedProps && typeof n.memoizedProps.onPress === 'function') { found = true; return; }
            scan(n.child, d + 1);
            if (!found) scan(n.sibling, d);
        })(f.child, 0);
        return found;
    }

    // Walk to find viewport dimensions (reused for heuristic overlay detection)
    var viewportW = 9999, viewportH = 9999;
    var rootHostFiber = findFirstHost(roots[0].current, 0);

    function walkForOverlays(fiber, depth) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps || {};

        if (name && OVERLAY_NAMES.test(name)) {
            // Collect host fibers in this overlay subtree
            var hosts = [];
            findHostsInSubtree(fiber, 0, hosts, 64);
            if (hosts.length > 0) {
                overlayFiberMeta.push({ type: classifyOverlay(name), fiber: fiber, hostFibers: hosts });
            }
            // Don't recurse deeper — nested overlays are unusual
            return;
        }

        // Native-stack modal (react-native-screens): a route presented as a modal /
        // formSheet covers the screens beneath it, but its component name ("Screen",
        // "RNSModalScreen") never matches OVERLAY_NAMES — so without this branch the
        // underlying route's pressables/text leak into the reachable list as if visible.
        // Detect via the stackPresentation prop. activityState === 0 means the screen is
        // inactive/offscreen (e.g. mid-dismiss) — skip it; undefined is treated as active.
        var sp = props.stackPresentation;
        if (typeof sp === 'string' && COVERING_PRESENTATIONS.test(sp) && props.activityState !== 0) {
            var modalHosts = [];
            findHostsInSubtree(fiber, 0, modalHosts, 64);
            if (modalHosts.length > 0) {
                // fullCover: a native covering modal occludes the entire screen beneath
                // it, so its block region is the whole viewport — not just its measured
                // content frame, which can sit inset from the screen edges (e.g. the tab
                // bar peeks past the modal's measured bottom and would wrongly read as
                // reachable). Resolved against viewport bounds in the resolve pass.
                overlayFiberMeta.push({ type: 'Modal', fiber: fiber, hostFibers: modalHosts, fullCover: true });
                // Don't recurse — the modal's own subtree is its content, captured above.
                return;
            }
        }

        // Geometric occluder: an opaque, absolutely-positioned host view holding at least
        // one pressable. This is the branch that catches a sheet mounted as an ordinary
        // view rather than as a Modal, a BottomSheet or a native presentation — a
        // third-party in-app devtool panel, a hand-rolled dialog — which none of the
        // name/prop classifiers above can recognise. Without it every element underneath
        // such a sheet is reported as reachable and taps on them silently hit the sheet.
        //
        // Two deliberate changes from the rule this replaces:
        //   - the size test moves to the resolve pass, which works on MEASURED frames.
        //     Requiring literal numeric style.width/height here missed every sheet sized
        //     by flex, percentages or an animated value, which is nearly all of them.
        //   - opacity is required. A translucent scrim leaves the screen visible and its
        //     elements legitimately reachable, so it must not count as a cover.
        // react-native-screens wraps every route in an absolutely-positioned, opaque
        // container full of pressables — structurally identical to a sheet and, measured,
        // 78% of the viewport. It is a route container, never an overlay: a screen
        // presented ON TOP of another is caught by the stackPresentation branch above,
        // which runs first. Excluding the family here is what keeps the whole visible
        // screen from being filed under an overlay group.
        var NAV_CONTAINER_HOST = /^RNS/;
        if (typeof fiber.type === 'string' && !NAV_CONTAINER_HOST.test(fiber.type)) {
            var style = flattenStyle(props.style);
            if (style && (style.zIndex > 999 || style.position === 'absolute') &&
                hasOpaqueSurface(fiber, style) && hasPressableDescendant(fiber)) {
                var hosts2 = [];
                findHostsInSubtree(fiber, 0, hosts2, 64);
                if (hosts2.length > 0) {
                    overlayFiberMeta.push({ type: 'Unknown', fiber: fiber, hostFibers: hosts2, geometric: true });
                    return;
                }
            }
        }

        var child = fiber.child;
        while (child) {
            walkForOverlays(child, depth + 1);
            child = child.sibling;
        }
    }
    walkForOverlays(roots[0].current, 0);

    // ------------------------------------------------------------------
    // 3. Pressable extraction — reuse PressabilityDebugView logic
    //    (same logic as get_pressable_elements; inline to avoid second CDP call)
    // ------------------------------------------------------------------

    var hostFibers = [];
    var fiberMeta = [];
    // overlayFiberMeta index -> fiberMeta index at which that overlay's subtree was entered.
    var overlayEnterIdx = [];
    // A count badge ("1", "99+") is the only text on icon buttons like a cart — treat it
    // as no-own-label so the icon child still surfaces (the count is kept as nearby text).
    var COUNT_BADGE = /^\\d{1,3}\\+?$/;

    // Shared with the input resolver — see injectedFilters.ts for why these must
    // not diverge (an agent reads a name here and passes it back as a target).
    var RN_PRIMITIVES = ${RN_PRIMITIVES_SRC};
    var GENERIC_COMPONENT = ${GENERIC_COMPONENT_SRC};
    var PDV_OWNER_COMPONENT = /^(Pressable|Touchable(Opacity|Highlight|WithoutFeedback|NativeFeedback|Bounce))$/;

    var PAGE_COMPONENT = /^(.*Screen|.*Page|.*View$|.*Container$|.*Layout$|.*Root$|ExpoRoot|App$)/;

    // Scroll/list containers end the search for a pressable's owning component.
    var SCROLL_BOUNDARY = /^(ScrollView|FlatList|SectionList|VirtualizedList|VirtualizedSectionList|RCTScrollView|RCTScrollContentView)$/;

    // Layout-only and touch-wrapper components skipped when scanning a pressable's
    // children for a meaningful icon component name (e.g. SvgChevronBack).
    var SKIP_IN_CHILD_SCAN = /^(View|Text|Image|ImageBackground|ScrollView|FlatList|SectionList|KeyboardAvoidingView|SafeAreaView|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TouchableNativeFeedback|Pressable|TextInput|ActivityIndicator|Switch|Modal|StatusBar|VirtualizedList|RefreshControl|Animated\\(.*|withAnimated.*|AnimatedComponent.*)$/;

    function findMeaningfulChildName(fiber) {
        function scan(f, d) {
            if (!f || d > 12) return null;
            var n = getComponentName(f);
            if (n && typeof f.type !== 'string' && !RN_PRIMITIVES.test(n) && !SKIP_IN_CHILD_SCAN.test(n)) return n;
            var c = f.child;
            while (c) {
                var r = scan(c, d + 1);
                if (r) return r;
                c = c.sibling;
            }
            return null;
        }
        return scan(fiber.child, 0);
    }

    function findMeaningfulAncestorName(fiber) {
        var cur = fiber.return;
        var depth = 0;
        var best = null;
        while (cur && depth < 20) {
            var n = getComponentName(cur);
            if (n && typeof cur.type !== 'string' && !RN_PRIMITIVES.test(n) && !GENERIC_COMPONENT.test(n)) {
                if (PAGE_COMPONENT.test(n)) break; // stop — too high, not useful
                best = n;
                break;
            }
            cur = cur.return;
            depth++;
        }
        return best;
    }

    // Nearest custom component FIBER for a pressable — its name is what an agent
    // can grep for in the codebase (OrderStepRow, CheckBox, Button). Own fiber when
    // the pressable itself is custom, else a capped climb over composite ancestors
    // (mirrors get_pressable_elements: stopping at the first composite is wrong,
    // generic wrappers like ForwardRef(View) sit in between).
    function resolveComponentFiber(fiber) {
        var ownName = getComponentName(fiber);
        if (ownName && typeof fiber.type !== 'string' && !GENERIC_COMPONENT.test(ownName) && !RN_PRIMITIVES.test(ownName)) return fiber;
        var an = fiber.return;
        var composites = 0;
        var dep = 0;
        while (an && dep < 12 && composites < 4) {
            if (typeof an.type !== 'string' && an.type !== null) {
                var n = getComponentName(an);
                if (n) {
                    // Stop at a scroll/list boundary. A pressable's owning component lives
                    // inside the same scroll container; past it the next non-generic ancestor
                    // is the screen itself, and "<TapTargetsScreen />" on a Submit button is a
                    // worse answer than the "<Pressable />" the caller falls back to.
                    if (SCROLL_BOUNDARY.test(n)) return null;
                    composites++;
                    if (!RN_PRIMITIVES.test(n) && !GENERIC_COMPONENT.test(n)) return an;
                }
            }
            an = an.return;
            dep++;
        }
        return null;
    }

    function resolveComponentName(fiber) {
        var cf = resolveComponentFiber(fiber);
        if (cf) return getComponentName(cf);
        // Nothing meaningful above this pressable: name the pressable itself. Climbing
        // further reaches the screen component, and "<TapTargetsScreen />" on a Submit
        // button is a worse answer than "<Pressable />".
        var own = getComponentName(fiber);
        if (own && typeof fiber.type !== 'string' && !RN_PRIMITIVES.test(own)) return own;
        return null;
    }

    // Event-handler props (onBack, onSelect, ...) of the custom component — context
    // for what the press triggers when the handler itself is anonymous. 'same' marks
    // identity with the touchable's onPress (pass-through props like onPress={onBack}),
    // which is the strongest signal of which prop the handler arrived through.
    function collectPropHandlers(fiber, directFn) {
        var cf = resolveComponentFiber(fiber);
        if (!cf || !cf.memoizedProps) return null;
        var ps = cf.memoizedProps;
        var out = [];
        for (var k in ps) {
            if (out.length >= 6) break;
            if (!/^on[A-Z]/.test(k)) continue;
            if (typeof ps[k] !== 'function') continue;
            out.push({ p: k, n: ps[k].name || '', same: directFn ? ps[k] === directFn : false });
        }
        return out.length ? out : null;
    }

    // Raw onPress handler info — name + source head. Whether it's displayable is
    // decided on the TS side (describePressHandler): Hermes bytecode bundles yield
    // minified names and '[bytecode]' source, which are filtered out there.
    function handlerHint(fn) {
        try {
            var n = fn.name || '';
            var s = '';
            try { s = String(fn); } catch(e2) {}
            if (s.indexOf('[bytecode]') !== -1 || s.indexOf('[native code]') !== -1) s = '';
            return { n: n, s: s ? s.replace(/\\s+/g, ' ').slice(0, 160) : '' };
        } catch(e) { return null; }
    }

    var ROLE_LABELS = {
        checkbox: 'Checkbox', switch: 'Switch', radio: 'Radio', button: 'Button',
        image: 'Image', imagebutton: 'Image Button', link: 'Link', menuitem: 'Menu Item',
        tab: 'Tab', togglebutton: 'Toggle Button', spinbutton: 'Spin Button'
    };

    function resolveLabel(primaryFiber, hostFiber, baseLabel, baseTestID) {
        if (baseLabel) return baseLabel;
        // accessibilityRole fallback
        var pProps = primaryFiber ? (primaryFiber.memoizedProps || {}) : {};
        var hProps = hostFiber ? (hostFiber.memoizedProps || {}) : {};
        var role = (hProps.accessibilityRole || pProps.accessibilityRole || hProps.role || pProps.role || '').toLowerCase();
        if (role && ROLE_LABELS[role]) {
            var state = hProps.accessibilityState || pProps.accessibilityState || {};
            var stateStr = '';
            if (state.checked === true) stateStr = ': checked';
            else if (state.checked === false) stateStr = ': unchecked';
            else if (state.selected === true) stateStr = ': selected';
            return '[' + ROLE_LABELS[role] + stateStr + ']';
        }
        // Meaningful ancestor component name fallback
        var ancestorName = primaryFiber ? findMeaningfulAncestorName(primaryFiber) : null;
        if (ancestorName) return '[' + ancestorName + ']';
        return baseTestID || null;
    }

    // The single pruning choke point for all three collection walks
    // (pressables, texts, images) — anything skipped here is skipped by all of
    // them consistently.
    //
    // LogBox is pruned unconditionally, but only *counted* when its subtree
    // actually holds a pressable. RN keeps LogBoxNotificationContainer mounted on
    // every dev screen, and it still renders a wrapper when there are no entries,
    // so neither "the fiber exists" nor "the fiber has a child" distinguishes a
    // live banner from the permanent empty one — both were tried, both put the
    // note on every screen read in dev, which is worse than the poisoning it was
    // added to fix. What the note is actually about is LogBox contributing
    // elements (the reported symptom was a screen answering with two LogBoxButtons
    // and nothing else), and those buttons only exist while a banner is up. So ask
    // that directly. Reading real LogBox state is the other option but costs a
    // module-registry walk, which is far too much for a per-screen read.
    var logBoxSkipped = 0;
    function logBoxHasPressable(fiber, depth) {
        if (!fiber || depth > 30) return false;
        var p = fiber.memoizedProps;
        if (p && (typeof p.onPress === 'function' || typeof p.onClick === 'function')) return true;
        var c = fiber.child;
        while (c) {
            if (logBoxHasPressable(c, depth + 1)) return true;
            c = c.sibling;
        }
        return false;
    }
    function isScreenHidden(name, props, fiber) {
        if (isLogBoxSubtree(name)) {
            if (fiber && logBoxHasPressable(fiber, 0)) logBoxSkipped++;
            return true;
        }
        return isHiddenNavigationScene(name, props);
    }

    // A pressable whose own rendered box is invisible must not be listed.
    //
    // Checking the composite alone is not enough: react-navigation's drawer scrim keeps
    // opacity on the host View it renders, while the Overlay composite above it carries
    // only a backgroundColor. The composite therefore looks visible, and by the time the
    // walk descends to the host that says opacity:0 the pressable has already been
    // collected — surfacing a full-screen tappable <Overlay /> over the middle of every
    // screen on any app with a drawer.
    function isHostHidden(hostFiber) {
        if (!hostFiber) return false;
        return isScreenHidden(getComponentName(hostFiber), hostFiber.memoizedProps, hostFiber);
    }

    function walkPressabilityDebugViews(fiber, depth, hidden, ovIdx) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps;
        var nextHidden = hidden || isScreenHidden(name, props, fiber);

        // Track which overlay subtree we're inside — membership by ancestry, not
        // geometry. A bottom sheet's subtree includes a full-screen backdrop, so
        // geometric containment wrongly swallows the underlying screen's pressables.
        if (ovIdx == null) {
            for (var ofi = 0; ofi < overlayFiberMeta.length; ofi++) {
                if (overlayFiberMeta[ofi].fiber === fiber) {
                    ovIdx = ofi;
                    // Paint position of the overlay, expressed on the same counter as the
                    // pressables. This walk is DFS pre-order over siblings in order, which
                    // is RN's paint order, so "collected earlier" == "painted underneath".
                    // Anything collected AFTER the overlay is drawn on top of it and must
                    // not be reported as blocked by it — a LogBox banner over a sheet, a
                    // toast over a dialog.
                    if (overlayEnterIdx[ofi] == null) overlayEnterIdx[ofi] = fiberMeta.length;
                    break;
                }
            }
        }

        if (!nextHidden && name === 'PressabilityDebugView') {
            var hostFiber = fiber.return;
            if (hostFiber && getMeasurable(hostFiber)) {
                var pressableFiber = hostFiber;
                var cur2 = hostFiber.return;
                var upD = 0;
                while (cur2 && upD < 10) {
                    if (typeof cur2.type !== 'string' && cur2.type !== null) {
                        var cn = getComponentName(cur2);
                        if (cn && PDV_OWNER_COMPONENT.test(cn)) { pressableFiber = cur2; break; }
                    }
                    cur2 = cur2.return;
                    upD++;
                }
                var pProps = pressableFiber.memoizedProps || {};
                var hProps = hostFiber.memoizedProps || {};
                var text = collectText(pressableFiber, 0);
                var testID = hProps.testID || hProps.nativeID || pProps.testID || pProps.nativeID || null;
                var a11y = hProps.accessibilityLabel || pProps.accessibilityLabel || null;
                var baseLabel = a11y || (text && text.length > 0 ? text.slice(0, 80) : null) || null;
                var label = resolveLabel(pressableFiber, hostFiber, baseLabel, testID);
                var badgeOnly = baseLabel ? COUNT_BADGE.test(baseLabel.trim()) : false;
                var icon = (baseLabel && !badgeOnly) ? null : findMeaningfulChildName(pressableFiber);
                if (!baseLabel && !icon) {
                    var ownName = getComponentName(pressableFiber);
                    if (ownName && !GENERIC_COMPONENT.test(ownName) && !RN_PRIMITIVES.test(ownName)) icon = ownName;
                }
                var hostIdx = hostFibers.length;
                hostFibers.push(hostFiber);
                var pressFn = (typeof pProps.onPress === 'function' && pProps.onPress) || (typeof hProps.onPress === 'function' && hProps.onPress) || null;
                fiberMeta.push({ label: label, testID: testID, hostIdx: hostIdx, icon: icon, overlayIdx: ovIdx, component: resolveComponentName(pressableFiber), hasOwnLabel: !!baseLabel, handler: pressFn ? handlerHint(pressFn) : null, propHandlers: collectPropHandlers(pressableFiber, pressFn), transform: transformStateOf(hostFiber) });
            }
            return;
        }

        // Fallback: onPress-based detection when PDV not present (production builds)
        if (!nextHidden && props && typeof props.onPress === 'function') {
            var hosts3 = [];
            findHostsInSubtree(fiber, 0, hosts3, 8);
            if (hosts3.length > 0 && !isHostHidden(hosts3[0])) {
                var p2 = fiber.memoizedProps || {};
                var text2 = collectText(fiber, 0);
                var a11y2 = p2.accessibilityLabel || null;
                var testID2 = p2.testID || p2.nativeID || null;
                var baseLabel2 = a11y2 || (text2 && text2.length > 0 ? text2.slice(0, 80) : null) || null;
                var label2 = resolveLabel(fiber, hosts3[0], baseLabel2, testID2);
                var badgeOnly2 = baseLabel2 ? COUNT_BADGE.test(baseLabel2.trim()) : false;
                var icon2 = (baseLabel2 && !badgeOnly2) ? null : findMeaningfulChildName(fiber);
                if (!baseLabel2 && !icon2) {
                    var ownName2 = getComponentName(fiber);
                    if (ownName2 && !GENERIC_COMPONENT.test(ownName2) && !RN_PRIMITIVES.test(ownName2)) icon2 = ownName2;
                }
                var hostIdx2 = hostFibers.length;
                hostFibers.push(hosts3[0]);
                fiberMeta.push({ label: label2, testID: testID2, hostIdx: hostIdx2, icon: icon2, overlayIdx: ovIdx, component: resolveComponentName(fiber), hasOwnLabel: !!baseLabel2, handler: handlerHint(props.onPress), propHandlers: collectPropHandlers(fiber, props.onPress), transform: transformStateOf(hosts3[0]) });
            }
        }

        // TextInputs — not covered by PressabilityDebugView or onPress.
        // A controlled TextInput holds its text in props.value, NOT in a child
        // text node, so collectText comes back empty for a filled field. Reading
        // value/defaultValue first is what stops a placeholder being reported as
        // the field's content (pressables.ts already did this; this aligns them).
        if (!nextHidden && props && typeof props.onPress !== 'function' &&
            (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function')) {
            var hostsI = [];
            findHostsInSubtree(fiber, 0, hostsI, 8);
            if (hostsI.length > 0) {
                var pI = fiber.memoizedProps || {};
                var textI = collectText(fiber, 0);
                var valueI = (typeof pI.value === 'string' && pI.value.length > 0) ? pI.value
                           : (typeof pI.defaultValue === 'string' && pI.defaultValue.length > 0) ? pI.defaultValue
                           : null;
                var placeholderI = (typeof pI.placeholder === 'string' && pI.placeholder.length > 0) ? pI.placeholder : null;
                var testIDI = pI.testID || pI.nativeID || null;
                var baseLabelI = pI.accessibilityLabel
                    || (valueI ? valueI.slice(0, 80) : null)
                    || (textI && textI.length > 0 ? textI.slice(0, 80) : null)
                    || (placeholderI ? placeholderI.slice(0, 80) : null)
                    || null;
                var labelI = resolveLabel(fiber, hostsI[0], baseLabelI, testIDI);
                var iconI = baseLabelI ? null : findMeaningfulChildName(fiber);
                var hostIdxI = hostFibers.length;
                hostFibers.push(hostsI[0]);
                fiberMeta.push({ label: labelI, testID: testIDI, hostIdx: hostIdxI, icon: iconI, overlayIdx: ovIdx, component: resolveComponentName(fiber), isInput: true, hasOwnLabel: !!baseLabelI, inputValue: valueI, inputPlaceholder: placeholderI, transform: transformStateOf(hostsI[0]) });
            }
        }

        // Switches / checkboxes — no onPress, no onChangeText, so none of the three
        // branches above sees them. They stayed out of the listing entirely, which
        // left guessing an x from a screenshot as the only way to reach one — and a
        // guess that lands on the neighbouring row is indistinguishable from a
        // correct toggle in the tap's pixel diff.
        //
        // Identity is the component, NOT the handler. Verified on device (RN 0.83):
        // an app renders <Switch value={x} /> with no onValueChange and drives it
        // from a gesture-handler row, so the fiber carries a value and nothing else.
        // Requiring onValueChange would have left that switch invisible — which is
        // the exact case this came from.
        var isSwitchHere = !nextHidden && props && typeof props.onPress !== 'function' &&
            typeof props.onChangeText !== 'function' &&
            (typeof props.onValueChange === 'function' ||
             (typeof fiber.type !== 'string' && name === 'Switch'));
        if (isSwitchHere) {
            var hostsS = [];
            findHostsInSubtree(fiber, 0, hostsS, 8);
            if (hostsS.length > 0 && !isHostHidden(hostsS[0])) {
                var pS = fiber.memoizedProps || {};
                var testIDS = pS.testID || pS.nativeID || null;
                var baseLabelS = pS.accessibilityLabel || null;
                var labelS = resolveLabel(fiber, hostsS[0], baseLabelS, testIDS);
                var hostIdxS = hostFibers.length;
                hostFibers.push(hostsS[0]);
                fiberMeta.push({ label: labelS, testID: testIDS, hostIdx: hostIdxS, icon: null, overlayIdx: ovIdx, component: resolveComponentName(fiber), hasOwnLabel: !!baseLabelS, switchValue: typeof pS.value === 'boolean' ? pS.value : null, transform: transformStateOf(hostsS[0]) });
            }
        }

        var child = fiber.child;
        while (child) {
            walkPressabilityDebugViews(child, depth + 1, nextHidden, ovIdx);
            child = child.sibling;
        }
    }
    walkPressabilityDebugViews(roots[0].current, 0, false, null);

    // ------------------------------------------------------------------
    // 3b. Standalone texts — proximity labels for icon-only pressables
    //     (checkbox/radio rows where the label is a sibling Text)
    // ------------------------------------------------------------------

    var textFibers = [];
    var textContents = [];
    var textOverlayIdx = [];
    var textTransforms = [];

    function extractTextString(fiber) {
        var p = fiber.memoizedProps;
        if (!p) return '';
        var ch = p.children;
        if (typeof ch === 'string') return ch;
        if (typeof ch === 'number') return String(ch);
        if (Array.isArray(ch)) {
            var parts = [];
            for (var k = 0; k < ch.length; k++) {
                if (typeof ch[k] === 'string') parts.push(ch[k]);
                else if (typeof ch[k] === 'number') parts.push(String(ch[k]));
            }
            if (parts.length > 0) return parts.join('');
        }
        return '';
    }

    function walkTexts(fiber, depth, insidePressable, inHidden, ovIdx) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps;
        var nextHidden = inHidden || isScreenHidden(name, props, fiber);

        // Overlay membership by ancestry (same as the pressable walk) so a sheet's
        // text is grouped with the sheet, not flagged as blocked behind it.
        if (ovIdx == null) {
            for (var ofiT = 0; ofiT < overlayFiberMeta.length; ofiT++) {
                if (overlayFiberMeta[ofiT].fiber === fiber) { ovIdx = ofiT; break; }
            }
        }

        var hasOnPress = props && typeof props.onPress === 'function';
        var isInputHere = props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');
        var nextInside = insidePressable || !!hasOnPress || !!isInputHere;

        // Record standalone text when outside any pressable — its own text already
        // labels the pressable it belongs to.
        if (!insidePressable && !nextHidden && name !== 'RCTText' && typeof fiber.type !== 'string') {
            var str = extractTextString(fiber);
            if (str && str.length > 0 && str.length <= 300) {
                // Measure the text's OWN host first.
                //
                // This used to climb to the nearest measurable ancestor, on the premise that a
                // Fabric RCTText has no publicInstance. getMeasurable has since grown a
                // nativeFabricUIManager branch that measures exactly those leaves, so the tight
                // glyph bounds are available — and climbing instead reported the enclosing
                // scroll container. That put "Taps: 0" and "Last: none" at one identical
                // full-width frame, hundreds of points from either string, and any centre
                // computed from it landed on unrelated UI.
                var measurableT = null;
                (function down(f, d) {
                    if (measurableT || !f || d > 6) return;
                    if (typeof f.type === 'string' && getMeasurable(f)) { measurableT = f; return; }
                    var c = f.child;
                    while (c && !measurableT) { down(c, d + 1); c = c.sibling; }
                })(fiber, 0);

                // Fall back to the old upward climb when the text renders no measurable host
                // of its own — a container proxy still beats dropping the text entirely.
                var up = fiber;
                var upDepth = 0;
                while (!measurableT && up && upDepth < 20) {
                    if (typeof up.type === 'string' && getMeasurable(up)) {
                        measurableT = up;
                        break;
                    }
                    up = up.return;
                    upDepth++;
                }
                if (measurableT) {
                    textFibers.push(measurableT);
                    textContents.push(str);
                    textOverlayIdx.push(ovIdx);
                    textTransforms.push(transformStateOf(measurableT));
                }
            }
        }

        var child = fiber.child;
        while (child) {
            walkTexts(child, depth + 1, nextInside, nextHidden, ovIdx);
            child = child.sibling;
        }
    }
    walkTexts(roots[0].current, 0, false, false, null);

    // ------------------------------------------------------------------
    // 3c. Images — host image components, with source + a11y label. Climb to
    //     the nearest measurable host (same proxy-bounds trick as text).
    // ------------------------------------------------------------------

    var imageFibers = [];
    var imageMeta = [];   // { src, alt }
    var IMG_NAME = /^(Image|RCTImageView|ExpoImage|FastImage|ImageBackground)$/;

    function imageSource(props) {
        if (!props) return null;
        var s = props.source;
        if (s == null) return null;
        if (Array.isArray(s)) s = s[0];
        if (typeof s === 'number') return 'asset#' + s;
        if (s && typeof s === 'object' && typeof s.uri === 'string') {
            return s.uri.length > 200 ? s.uri.slice(0, 200) : s.uri;
        }
        if (typeof s === 'string') return s.length > 200 ? s.slice(0, 200) : s;
        return null;
    }

    function walkImages(fiber, depth, inHidden, ovIdx) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps;
        var nextHidden = inHidden || isScreenHidden(name, props, fiber);
        if (ovIdx == null) {
            for (var ofiI = 0; ofiI < overlayFiberMeta.length; ofiI++) {
                if (overlayFiberMeta[ofiI].fiber === fiber) { ovIdx = ofiI; break; }
            }
        }
        if (!nextHidden && name && IMG_NAME.test(name) && typeof fiber.type !== 'string') {
            var up = fiber;
            var upD = 0;
            var measurableI = null;
            while (up && upD < 20) {
                if (typeof up.type === 'string' && getMeasurable(up)) { measurableI = up; break; }
                up = up.return;
                upD++;
            }
            if (measurableI) {
                imageFibers.push(measurableI);
                imageMeta.push({
                    src: imageSource(props),
                    alt: (props && typeof props.accessibilityLabel === 'string') ? props.accessibilityLabel.slice(0, 80) : null,
                    overlayIdx: ovIdx,
                    transform: transformStateOf(measurableI)
                });
            }
        }
        var child = fiber.child;
        while (child) { walkImages(child, depth + 1, nextHidden, ovIdx); child = child.sibling; }
    }
    walkImages(roots[0].current, 0, false, null);

    // Native-presented sheets (e.g. True Sheet) render their content into a detached native
    // context whose measureInWindow data is unreliable. Collect open-sheet host markers so
    // the resolve pass can flag a nativeOverlay and steer the agent to screenshot/OCR.
    var __nativeSheetMarkers = [];
    var __NATIVE_SHEET_RE = /^(${NATIVE_SHEET_MARKER_RE_SRC})$/;
    (function scanNative(fiber, depth) {
        if (!fiber || depth > 5000) return;
        var nm = getComponentName(fiber);
        if (nm && __NATIVE_SHEET_RE.test(nm)) __nativeSheetMarkers.push(nm);
        var c = fiber.child;
        while (c) { scanNative(c, depth + 1); c = c.sibling; }
    })(roots[0].current, 0);
    globalThis.__screenStateNativeMarkers = __nativeSheetMarkers;
    // Handed to the collect expression, which runs in a separate evaluation and
    // cannot see this scope — same channel the native markers use.
    globalThis.__screenStateLogBoxSkipped = logBoxSkipped;

    // ------------------------------------------------------------------
    // 4. Store everything in globalThis for the resolve call
    // ------------------------------------------------------------------

    // Store overlay host fibers separately
    var overlayHostFibers = [];
    var overlayMetaList = overlayFiberMeta.map(function(om, omIdx) {
        var startIdx = overlayHostFibers.length;
        for (var hi = 0; hi < om.hostFibers.length; hi++) {
            overlayHostFibers.push(om.hostFibers[hi]);
        }
        var title = collectText(om.fiber, 0);
        return {
            type: om.type,
            title: (title && title.length > 2) ? title.slice(0, 60) : null,
            hostStart: startIdx,
            hostEnd: overlayHostFibers.length,
            fullCover: !!om.fullCover,
            geometric: !!om.geometric,
            // null means "never entered during the pressable walk" — treat as painted last
            // (Infinity) so a subtree with no pressables of its own cannot block anything.
            enterIdx: overlayEnterIdx[omIdx] == null ? -1 : overlayEnterIdx[omIdx]
        };
    });

    // Measure root for viewport
    var rootIdx = -1;
    if (rootHostFiber) {
        rootIdx = hostFibers.length;
        hostFibers.push(rootHostFiber);
    }

    // Sheet boundaries. A modally-presented screen is laid out by UIKit at an
    // offset RN's own measurements do not include (see injected/sheetOffset.ts),
    // so every frame beneath one needs the same vertical correction. Resolved
    // from the measured host rather than the push sites: the boundary is a
    // property of where a fiber sits, and asking the fiber keeps the six
    // collection branches out of it.
    var sheetFibers = [];
    function sheetIndexFor(fiber) {
        var b = modalBoundaryOf(fiber);
        if (!b) return -1;
        for (var sfi = 0; sfi < sheetFibers.length; sfi++) {
            if (sheetFibers[sfi] === b) return sfi;
        }
        sheetFibers.push(b);
        return sheetFibers.length - 1;
    }
    function sheetIndexesOf(list) {
        var out = [];
        for (var li = 0; li < list.length; li++) out.push(sheetIndexFor(list[li]));
        return out;
    }
    globalThis.__screenStateSheetIdx = sheetIndexesOf(hostFibers);
    globalThis.__screenStateTextSheetIdx = sheetIndexesOf(textFibers);
    globalThis.__screenStateImageSheetIdx = sheetIndexesOf(imageFibers);
    globalThis.__screenStateOverlaySheetIdx = sheetIndexesOf(overlayHostFibers);
    globalThis.__screenStateSheetMeasurements = new Array(sheetFibers.length).fill(null);
    for (var shi = 0; shi < sheetFibers.length; shi++) {
        try {
            (function(idx) {
                getMeasurable(sheetFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                    globalThis.__screenStateSheetMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                });
            })(shi);
        } catch(e) {}
    }

    globalThis.__screenStateFibers = hostFibers;
    globalThis.__screenStateMeta = fiberMeta;
    globalThis.__screenStateMeasurements = new Array(hostFibers.length).fill(null);
    globalThis.__screenStateRootIdx = rootIdx;
    globalThis.__screenStateRoute = route;
    globalThis.__screenStateOverlayHostFibers = overlayHostFibers;
    globalThis.__screenStateOverlayMeta = overlayMetaList;
    globalThis.__screenStateOverlayMeasurements = new Array(overlayHostFibers.length).fill(null);
    globalThis.__screenStateTextContents = textContents;
    globalThis.__screenStateTextMeasurements = new Array(textFibers.length).fill(null);
    globalThis.__screenStateTextOverlayIdx = textOverlayIdx;
    globalThis.__screenStateTextTransforms = textTransforms;
    globalThis.__screenStateImageMeta = imageMeta;
    globalThis.__screenStateImageMeasurements = new Array(imageFibers.length).fill(null);

    // Dispatch all measureInWindow calls (pressables + root + overlay hosts)
    for (var i = 0; i < hostFibers.length; i++) {
        try {
            (function(idx) {
                getMeasurable(hostFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                    globalThis.__screenStateMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                });
            })(i);
        } catch(e) {}
    }
    for (var oi = 0; oi < overlayHostFibers.length; oi++) {
        try {
            (function(idx) {
                getMeasurable(overlayHostFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                    globalThis.__screenStateOverlayMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                });
            })(oi);
        } catch(e) {}
    }
    for (var txi = 0; txi < textFibers.length; txi++) {
        try {
            (function(idx) {
                getMeasurable(textFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                    globalThis.__screenStateTextMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                });
            })(txi);
        } catch(e) {}
    }
    for (var imi = 0; imi < imageFibers.length; imi++) {
        try {
            (function(idx) {
                getMeasurable(imageFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                    globalThis.__screenStateImageMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                });
            })(imi);
        } catch(e) {}
    }

    return { count: hostFibers.length + textFibers.length + imageFibers.length, overlayCount: overlayFiberMeta.length };
})()
    `;

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000, originatingToolName: "get_screen_state" }, device);
    if (!dispatchResult.success) return dispatchResult;

    let dispatchedNodes = 0;
    try {
        const dp = JSON.parse(dispatchResult.result || "{}");
        if (dp.error) return { success: false, error: dp.error };
        if (typeof dp.count === "number") dispatchedNodes = dp.count;
    } catch { /* ignore */ }

    // Scale the wait with the node count instead of a flat 300ms.
    //
    // measureInWindow callbacks land asynchronously, and every one that has not fired by
    // the time the resolve pass runs is a null slot — an element that silently does not
    // appear in the output. 300ms was ample for a small screen and demonstrably not for a
    // dense list, which is how whole blocks came and went between identical calls. Same
    // budget shape inspect_at_point already uses.
    const measureBudgetMs = Math.min(3000, 400 + dispatchedNodes * 2);
    await delay(measureBudgetMs);

    const resolveExpression = `
(function() {
    ${SHEET_HELPERS_JS}
    var hostFibers = globalThis.__screenStateFibers;
    var meta = globalThis.__screenStateMeta;
    var measurements = globalThis.__screenStateMeasurements;
    var rootIdx = globalThis.__screenStateRootIdx;
    var route = globalThis.__screenStateRoute;
    var overlayMeta = globalThis.__screenStateOverlayMeta || [];
    var overlayMeasurements = globalThis.__screenStateOverlayMeasurements || [];
    var textContents = globalThis.__screenStateTextContents || [];
    var textMeasurements = globalThis.__screenStateTextMeasurements || [];
    var textOverlayIdx = globalThis.__screenStateTextOverlayIdx || [];
    var textTransforms = globalThis.__screenStateTextTransforms || [];
    var imageMeta = globalThis.__screenStateImageMeta || [];
    var imageMeasurements = globalThis.__screenStateImageMeasurements || [];
    var sheetMeasurements = globalThis.__screenStateSheetMeasurements || [];
    var sheetIdx = globalThis.__screenStateSheetIdx || [];
    var textSheetIdx = globalThis.__screenStateTextSheetIdx || [];
    var imageSheetIdx = globalThis.__screenStateImageSheetIdx || [];
    var overlaySheetIdx = globalThis.__screenStateOverlaySheetIdx || [];
    globalThis.__screenStateSheetMeasurements = null;
    globalThis.__screenStateSheetIdx = null;
    globalThis.__screenStateTextSheetIdx = null;
    globalThis.__screenStateImageSheetIdx = null;
    globalThis.__screenStateOverlaySheetIdx = null;
    var nativeMarkers = globalThis.__screenStateNativeMarkers || [];
    var logBoxSkipped = globalThis.__screenStateLogBoxSkipped || 0;
    globalThis.__screenStateNativeMarkers = null;
    globalThis.__screenStateLogBoxSkipped = null;
    globalThis.__screenStateTextContents = null;
    globalThis.__screenStateTextMeasurements = null;
    globalThis.__screenStateTextOverlayIdx = null;
    globalThis.__screenStateTextTransforms = null;
    globalThis.__screenStateImageMeta = null;
    globalThis.__screenStateImageMeasurements = null;
    globalThis.__screenStateFibers = null;
    globalThis.__screenStateMeta = null;
    globalThis.__screenStateMeasurements = null;
    globalThis.__screenStateRootIdx = null;
    globalThis.__screenStateRoute = null;
    globalThis.__screenStateOverlayHostFibers = null;
    globalThis.__screenStateOverlayMeta = null;
    globalThis.__screenStateOverlayMeasurements = null;

    if (!hostFibers || !measurements || !meta) {
        return { error: 'No measurement data. Run get_screen_state again.' };
    }

    // Viewport
    var viewportW = 9999, viewportH = 9999;
    var rootM = (rootIdx != null && rootIdx >= 0) ? measurements[rootIdx] : null;
    if (rootM && rootM.width > 0 && rootM.height > 0) {
        viewportW = rootM.width;
        viewportH = rootM.height + (rootM.y > 0 ? rootM.y : 0);
    }

    // Sheet correction. UIKit presents a modal screen inset from the top of the
    // window and RN's measurements do not include that inset, so every frame on
    // such a screen is short by exactly one number — recoverable because the
    // sheet is bottom-anchored and its own host measures its real height.
    var sheetShifts = [];
    var sheetShiftApplied = 0;
    for (var ssi = 0; ssi < sheetMeasurements.length; ssi++) {
        var dyS = sheetShiftY(sheetMeasurements[ssi], { width: viewportW, height: viewportH });
        sheetShifts.push(dyS);
        if (dyS > sheetShiftApplied) sheetShiftApplied = dyS;
    }
    function shiftFor(idxList, i) {
        var si = idxList && idxList[i] != null ? idxList[i] : -1;
        return si >= 0 && sheetShifts[si] ? sheetShifts[si] : 0;
    }

    // Build overlay bounds by unioning their host measurements.
    // blockBounds: union of ALL hosts (incl. full-screen backdrop) — what the overlay
    //   visually blocks; used to exclude unreachable root pressables.
    // contentBounds: union excluding near-viewport-sized hosts (backdrops) — the
    //   actual panel; used as geometric fallback for portaled overlay content.
    var overlays = [];
    var vArea = viewportW * viewportH;
    for (var oi = 0; oi < overlayMeta.length; oi++) {
        var om = overlayMeta[oi];
        var bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity, bValid = false;
        var cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cValid = false;
        for (var hi = om.hostStart; hi < om.hostEnd; hi++) {
            var mm = shiftRect(overlayMeasurements[hi], shiftFor(overlaySheetIdx, hi));
            if (!mm || mm.width <= 0 || mm.height <= 0) continue;
            bValid = true;
            if (mm.x < bMinX) bMinX = mm.x;
            if (mm.y < bMinY) bMinY = mm.y;
            if (mm.x + mm.width > bMaxX) bMaxX = mm.x + mm.width;
            if (mm.y + mm.height > bMaxY) bMaxY = mm.y + mm.height;
            if (mm.width * mm.height >= vArea * 0.9) continue; // backdrop-sized → block only
            cValid = true;
            if (mm.x < cMinX) cMinX = mm.x;
            if (mm.y < cMinY) cMinY = mm.y;
            if (mm.x + mm.width > cMaxX) cMaxX = mm.x + mm.width;
            if (mm.y + mm.height > cMaxY) cMaxY = mm.y + mm.height;
        }
        if (!bValid) continue;
        // Size gate for geometric candidates, applied here because this is the first
        // point where a measured frame exists.
        //
        // The upper bound is the important half. A candidate covering essentially the
        // whole viewport is far more likely to be a screen container (react-native-screens
        // wraps routes in absoluteFill views, which are opaque and full of pressables)
        // than a sheet, and promoting one to "overlay" would file the entire visible
        // screen under an overlay group. Genuine full-screen covers arrive as Modal or as
        // a covering stackPresentation and are classified above, before this branch runs.
        if (om.geometric) {
            var gArea = (bMaxX - bMinX) * (bMaxY - bMinY);
            if (!(vArea > 0) || gArea < vArea * 0.15 || gArea > vArea * 0.92) continue;
            // A closed drawer is an opaque, absolutely-positioned, pressable-filled panel
            // that happens to be parked off-screen (measured at x = -width). It covers
            // nothing until it slides in, so candidacy has to be judged on the visible
            // intersection rather than the panel's own size.
            var visW = Math.min(bMaxX, viewportW) - Math.max(bMinX, 0);
            var visH = Math.min(bMaxY, viewportH) - Math.max(bMinY, 0);
            if (visW <= 0 || visH <= 0 || (visW * visH) < gArea * 0.6) continue;
        }
        // Native covering modals occlude the whole screen — expand their block region to
        // the full viewport so elements that extend past the modal's measured content
        // frame (e.g. the bottom tab bar) are still flagged as blocked, not reachable.
        var blockBounds = om.fullCover
            ? { x: 0, y: 0, width: Math.round(viewportW), height: Math.round(viewportH) }
            : { x: Math.round(bMinX), y: Math.round(bMinY), width: Math.round(bMaxX - bMinX), height: Math.round(bMaxY - bMinY) };
        // When every host is backdrop-sized (gorhom sheets measure only full-screen
        // containers), there is no usable content rect — geometric fallback would
        // swallow the underlying screen's pressables, so it is disabled (hasContent).
        var contentBounds = cValid
            ? { x: Math.round(cMinX), y: Math.round(cMinY), width: Math.round(cMaxX - cMinX), height: Math.round(cMaxY - cMinY) }
            : blockBounds;
        // Geometric overlays never adopt by geometry. A classified overlay may portal its
        // content elsewhere in the tree, so containment is a needed fallback for it; a
        // geometric candidate is a plain in-tree view whose content is exactly its fiber
        // descendants. Letting it claim everything inside its rect would file the bottom
        // tab bar as part of the sheet drawn over it, when the truth is the opposite —
        // the tab bar is behind it and blocked.
        var geometric = !!om.geometric;
        overlays.push({ origIdx: oi, type: om.type, title: om.title, blockBounds: blockBounds, contentBounds: contentBounds, hasContent: cValid && !geometric, geometric: geometric, enterIdx: om.enterIdx, pressables: [] });
    }

    // A measurement callback that never fired leaves null here. Counting those is the
    // difference between "there is nothing there" and "we did not find out" — the second
    // used to render as the first, and silence reads as evidence.
    var unmeasuredCount = 0;

    /** Outside the viewport by the frame given. */
    function offViewport(m) {
        if (m.x + m.width < 0 || m.y + m.height < 0) return true;
        if (m.x > viewportW || m.y > viewportH) return true;
        return false;
    }

    /**
     * Fold the composed translation into the measured frame, and decide whether the result
     * is worth warning about.
     *
     * The tag is deliberately NOT raised for every uncertain transform. An Animated value
     * that currently reads 0 on an element that measures on screen is almost certainly
     * exactly where it says it is; tagging those buries the one case that matters. Even a
     * sticky header is at its measured position while the list sits at the top — it only
     * starts lying once it is pinned, and then it measures off-screen.
     *
     * So what earns a tag is a transform that is visibly doing something: a non-zero
     * composed offset, or a frame that lands off-screen — the exact shape that used to make
     * pinned headers disappear from the listing. The cost is a narrow blind spot mid-
     * animation, where an element is displaced but still measures on screen; the gain is
     * that a tag, when it appears, means something.
     */
    function withTransform(m, tf) {
        if (!tf) return { m: m, unreliable: false, note: null };
        var moved = { x: m.x + tf.dx, y: m.y + tf.dy, width: m.width, height: m.height };
        var displaced = tf.dx !== 0 || tf.dy !== 0;
        var worthWarning = tf.uncertain && (displaced || offViewport(moved));
        return { m: moved, unreliable: worthWarning, note: worthWarning ? tf.label : null };
    }

    /**
     * Should this element be listed?
     *
     * An element whose frame is pre-transform must NOT be viewport-filtered on that frame.
     * A pinned sticky header measures hundreds of points above the screen while sitting in
     * plain sight, and dropping it made whole blocks — title, tab bar, search field —
     * vanish from the listing with no indication anything had been omitted.
     */
    function keepElement(m, unreliable) {
        if (m.width <= 0 || m.height <= 0) return false;
        return unreliable || !offViewport(m);
    }

    // Build pressable list
    var allPressables = [];
    for (var i = 0; i < meta.length; i++) {
        if (i === rootIdx) continue;
        var m0 = measurements[i];
        if (!m0) { unmeasuredCount++; continue; }
        var tr = withTransform(shiftRect(m0, shiftFor(sheetIdx, i)), meta[i].transform);
        var m = tr.m;
        if (!keepElement(m, tr.unreliable)) continue;
        allPressables.push({
            transformNote: tr.note,
            // Position in the DFS collection order == paint order. Kept so occlusion can
            // ask "was this drawn before the overlay?" rather than only "is it inside it?".
            paintIdx: i,
            label: meta[i].label,
            component: meta[i].component || null,
            center: { x: Math.round(m.x + m.width / 2), y: Math.round(m.y + m.height / 2) },
            bounds: { x: Math.round(m.x), y: Math.round(m.y), width: Math.round(m.width), height: Math.round(m.height) },
            testID: meta[i].testID,
            icon: meta[i].icon || null,
            isInput: !!meta[i].isInput,
            switchValue: (meta[i].switchValue != null ? meta[i].switchValue : undefined),
            inputValue: (meta[i].inputValue != null ? meta[i].inputValue : null),
            inputPlaceholder: (meta[i].inputPlaceholder != null ? meta[i].inputPlaceholder : null),
            overlayIdx: (meta[i].overlayIdx != null ? meta[i].overlayIdx : null),
            hasOwnLabel: !!meta[i].hasOwnLabel,
            handler: meta[i].handler || null,
            propHandlers: meta[i].propHandlers || null
        });
    }

    // Attach nearbyText to pressables without their own text/a11y label.
    // Row siblings first (checkbox labels), center distance as fallback.
    var textBoxes = [];
    for (var tmi = 0; tmi < textMeasurements.length; tmi++) {
        var tm0 = textMeasurements[tmi];
        var tc = textContents[tmi];
        if (!tm0 || !tc) continue;
        var ttr = withTransform(shiftRect(tm0, shiftFor(textSheetIdx, tmi)), textTransforms[tmi]);
        var tm = ttr.m;
        if (!keepElement(tm, ttr.unreliable)) continue;
        textBoxes.push({ text: tc, x: tm.x, y: tm.y, width: tm.width, height: tm.height, cx: tm.x + tm.width / 2, cy: tm.y + tm.height / 2 });
    }
    for (var ni = 0; ni < allPressables.length; ni++) {
        var pn = allPressables[ni];
        if (pn.hasOwnLabel || textBoxes.length === 0) continue;
        var bestT = null;
        var bestD = Infinity;
        for (var tbi = 0; tbi < textBoxes.length; tbi++) {
            var tb = textBoxes[tbi];
            if (tb.x >= pn.bounds.x && tb.y >= pn.bounds.y &&
                tb.x + tb.width <= pn.bounds.x + pn.bounds.width &&
                tb.y + tb.height <= pn.bounds.y + pn.bounds.height) continue;
            var rowAligned = Math.abs(tb.cy - pn.center.y) <= Math.max(24, pn.bounds.height / 2);
            var gapL = pn.bounds.x - (tb.x + tb.width);
            var gapR = tb.x - (pn.bounds.x + pn.bounds.width);
            var hGap = Math.max(gapL, gapR);
            if (hGap < 0) hGap = 0;
            var d;
            if (rowAligned && hGap <= 80) {
                d = hGap;
            } else {
                var dxT = tb.cx - pn.center.x;
                var dyT = tb.cy - pn.center.y;
                d = Math.sqrt(dxT * dxT + dyT * dyT);
                if (d > 120) continue;
            }
            if (d < bestD) { bestD = d; bestT = tb; }
        }
        if (bestT) pn.nearbyText = bestT.text.slice(0, 80);
    }

    // Assign pressables to overlays vs root:
    // 1. fiber ancestry (pressable rendered inside the overlay subtree)
    // 2. geometric containment in contentBounds (portaled overlay content)
    // 3. fully covered by blockBounds (incl. backdrop) → unreachable, drop
    // 4. otherwise root
    var rootPressables = [];
    function inside(b, ob) {
        return b.x >= ob.x && b.y >= ob.y &&
            b.x + b.width <= ob.x + ob.width &&
            b.y + b.height <= ob.y + ob.height;
    }

    // A geometric candidate has to earn its place: it must either own pressable content or
    // actually cover something. The name-based classifiers describe a real widget whether
    // or not it currently holds a button, but "opaque absolute view" is a guess, and a
    // guess that occludes nothing buys no information — it only adds an empty overlay
    // group to the output and invites the reader to treat a plain view as a sheet.
    // True when this overlay is painted over that pressable: the pressable is inside its
    // rect, is not part of its own subtree, and was collected before it.
    function occludes(o, p) {
        return p.overlayIdx !== o.origIdx &&
            o.enterIdx >= 0 && p.paintIdx < o.enterIdx &&
            inside(p.bounds, o.blockBounds);
    }

    var keptOverlays = [];
    for (var fo = 0; fo < overlays.length; fo++) {
        var cand = overlays[fo];
        if (!cand.geometric) { keptOverlays.push(cand); continue; }
        // A geometric candidate must actually cover something that is not its own content.
        // Owning pressables is NOT enough: react-native-screens wraps every route in an
        // absolutely-positioned container that paints an opaque background and is full of
        // pressables, and promoting one to "overlay" files the whole visible screen under
        // an overlay group and empties the reachable list. Occluding a foreign element is
        // what distinguishes a sheet from a screen container.
        var earns = false;
        for (var cp = 0; cp < allPressables.length && !earns; cp++) {
            if (occludes(cand, allPressables[cp])) earns = true;
        }
        if (earns) keptOverlays.push(cand);
    }
    overlays = keptOverlays;
    for (var pi = 0; pi < allPressables.length; pi++) {
        var p = allPressables[pi];
        var assignedToOverlay = false;
        for (var ov = 0; ov < overlays.length; ov++) {
            if (p.overlayIdx === overlays[ov].origIdx ||
                (p.overlayIdx == null && overlays[ov].hasContent && inside(p.bounds, overlays[ov].contentBounds))) {
                overlays[ov].pressables.push(p);
                assignedToOverlay = true;
                break;
            }
        }
        if (!assignedToOverlay) {
            // Covered pressables stay in the list but are flagged — agents see what's
            // behind the sheet while knowing taps won't reach it until it closes.
            for (var ov2 = 0; ov2 < overlays.length; ov2++) {
                // Geometric overlays respect paint order, so a banner drawn on top of a
                // sheet is not reported as hidden by it. The name-classified overlays keep
                // the original containment-only rule: a Modal or a native sheet occludes
                // what is behind it regardless of where its subtree sits in the walk.
                var blocks = overlays[ov2].geometric
                    ? occludes(overlays[ov2], p)
                    : inside(p.bounds, overlays[ov2].blockBounds);
                if (blocks) { p.blockedByOverlay = true; break; }
            }
            rootPressables.push(p);
        }
    }
    for (var si = 0; si < allPressables.length; si++) {
        delete allPressables[si].overlayIdx;
        delete allPressables[si].hasOwnLabel;
        delete allPressables[si].paintIdx;
    }

    // Build typed text/image lists (pair each measurement with its meta by index,
    // viewport-filter) and assign each to a reachability group via the same overlay
    // logic used for pressables (content containment vs blocking backdrop).
    var rootTexts = [], rootImages = [];
    for (var ov = 0; ov < overlays.length; ov++) { overlays[ov].texts = []; overlays[ov].images = []; }
    // Group an item: by fiber ancestry (overlayIdx) first — a sheet's own text/image
    // belongs to the sheet; else geometric containment in an overlay's content; else
    // root, flagged blocked when it sits under a blocking overlay (the screen behind).
    function pushClassified(entry, kind, ovIdx) {
        for (var a = 0; a < overlays.length; a++) {
            if (ovIdx != null && ovIdx === overlays[a].origIdx) { overlays[a][kind].push(entry); return; }
        }
        for (var c = 0; c < overlays.length; c++) {
            if (overlays[c].hasContent && inside(entry.bounds, overlays[c].contentBounds)) { overlays[c][kind].push(entry); return; }
        }
        var blk = false;
        for (var b = 0; b < overlays.length; b++) { if (inside(entry.bounds, overlays[b].blockBounds)) { blk = true; break; } }
        if (blk) entry.blockedByOverlay = true;
        (kind === 'texts' ? rootTexts : rootImages).push(entry);
    }

    for (var ti = 0; ti < textContents.length; ti++) {
        var tmA = textMeasurements[ti];
        if (!tmA) { unmeasuredCount++; continue; }
        var tTr = withTransform(shiftRect(tmA, shiftFor(textSheetIdx, ti)), textTransforms[ti]);
        var tm2 = tTr.m;
        if (!keepElement(tm2, tTr.unreliable)) continue;
        pushClassified({ text: textContents[ti],
            transformNote: tTr.note,
            center: { x: Math.round(tm2.x + tm2.width/2), y: Math.round(tm2.y + tm2.height/2) },
            bounds: { x: Math.round(tm2.x), y: Math.round(tm2.y), width: Math.round(tm2.width), height: Math.round(tm2.height) } }, 'texts', textOverlayIdx[ti]);
    }
    for (var ii = 0; ii < imageMeta.length; ii++) {
        var imA = imageMeasurements[ii];
        if (!imA) { unmeasuredCount++; continue; }
        var iTr = withTransform(shiftRect(imA, shiftFor(imageSheetIdx, ii)), imageMeta[ii].transform);
        var im = iTr.m;
        if (!keepElement(im, iTr.unreliable)) continue;
        pushClassified({ src: imageMeta[ii].src, alt: imageMeta[ii].alt,
            transformNote: iTr.note,
            center: { x: Math.round(im.x + im.width/2), y: Math.round(im.y + im.height/2) },
            bounds: { x: Math.round(im.x), y: Math.round(im.y), width: Math.round(im.width), height: Math.round(im.height) } }, 'images', imageMeta[ii].overlayIdx);
    }

    // Sort visually (top-to-bottom, left-to-right) — walk order is mount order,
    // which puts late-mounted overlays like floating headers at the end.
    function byPosition(a, b) {
        if (a.center.y !== b.center.y) return a.center.y - b.center.y;
        return a.center.x - b.center.x;
    }
    rootPressables.sort(byPosition);
    rootTexts.sort(byPosition);
    rootImages.sort(byPosition);
    for (var so = 0; so < overlays.length; so++) {
        overlays[so].pressables.sort(byPosition);
        overlays[so].texts.sort(byPosition);
        overlays[so].images.sort(byPosition);
    }

    // Strip bounds from overlay objects (not in public interface)
    var cleanOverlays = overlays.map(function(o) {
        return { type: o.type, title: o.title, pressables: o.pressables, texts: o.texts, images: o.images };
    });

    // Everything the caller needs to judge how complete this snapshot is. Both counts used
    // to be invisible: an unmeasured node and a node that genuinely is not there produced
    // exactly the same output — nothing.
    var transformedCount = 0;
    function countTransformed(list) {
        for (var q = 0; q < list.length; q++) if (list[q] && list[q].transformNote) transformedCount++;
    }
    countTransformed(rootPressables); countTransformed(rootTexts); countTransformed(rootImages);
    for (var co = 0; co < overlays.length; co++) {
        countTransformed(overlays[co].pressables);
        countTransformed(overlays[co].texts || []);
        countTransformed(overlays[co].images || []);
    }

    return { route: route, overlays: cleanOverlays, pressables: rootPressables, texts: rootTexts, images: rootImages, nativeMarkers: nativeMarkers,
        logBoxSkipped: logBoxSkipped,
        unmeasuredCount: unmeasuredCount, transformedCount: transformedCount, sheetShift: Math.round(sheetShiftApplied),
        dispatchedCount: meta.length + textContents.length + imageMeta.length };
})()
    `;

    const resolveResult = await executeInApp(resolveExpression, false, { timeoutMs: 15000, originatingToolName: "get_screen_state" }, device);

    if (!resolveResult.success) return resolveResult;

    let screenState: ScreenState | undefined;
    let counts: {
        unmeasuredCount?: number;
        transformedCount?: number;
        sheetShift?: number;
        dispatchedCount?: number;
        logBoxSkipped?: number;
    } = {};
    try {
        const parsed = JSON.parse(resolveResult.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
        counts = parsed as typeof counts;
        screenState = parseScreenStateResponse(parsed) ?? undefined;
    } catch {
        return { success: false, error: "Failed to parse screen state response" };
    }

    if (!screenState) return { success: false, error: "Empty screen state response" };

    // Surface incompleteness rather than shipping a shorter list and letting it read as
    // "that is everything on screen".
    const completenessNotes: string[] = [];
    if ((counts.unmeasuredCount ?? 0) > 0) {
        completenessNotes.push(
            `${counts.unmeasuredCount} element(s) did not return a measurement within ${measureBudgetMs}ms and are NOT listed below. ` +
            `This is a timing miss, not an empty screen — call get_screen_state again, or take a screenshot, before concluding anything is absent.`
        );
    }
    if ((counts.transformedCount ?? 0) > 0) {
        completenessNotes.push(
            `${counts.transformedCount} element(s) are marked ⚠transformed. Their frames come from the layout tree, which does not include ` +
            `native-driven transforms (sticky headers, collapsing toolbars, animating sheets), so the coordinates may not be where the element ` +
            `is drawn. Confirm against a screenshot before tapping those.`
        );
    }
    // A corrected coordinate that says nothing is still a coordinate the caller
    // cannot check against a screenshot, so name the correction and its size.
    if ((counts.sheetShift ?? 0) > 0) {
        completenessNotes.push(
            `This screen is presented as a modal sheet, which UIKit insets from the top of the window. React Native's measurements do not include ` +
            `that inset, so every frame below has been corrected by +${counts.sheetShift}pt to match what is actually on screen.`
        );
    }
    // LogBox's own controls used to be the only pressables a screen read returned
    // whenever the banner was up, because it mounts above the app. Its subtree is
    // pruned now — but a pruned list that does not say so reads as "the screen is
    // empty", so name the banner and point at the tool that deals with it.
    if ((counts.logBoxSkipped ?? 0) > 0) {
        completenessNotes.push(
            `A LogBox overlay (RN's red/yellow error banner) is mounted and was excluded from this snapshot — the elements below are the app's, not LogBox's. ` +
            `The banner still covers part of the screen, so a bottom- or top-anchored element listed here may not be tappable where it says. ` +
            `Use logbox({action:"detect"}) to read the error, or logbox({action:"dismiss"}) to read and clear it.`
        );
    }
    if (completenessNotes.length > 0) {
        screenState.notes = [...(screenState.notes ?? []), ...completenessNotes];
    }

    // Deduplicate pressables by center coordinates (PDV + onPress fallback can both fire)
    const dedupPressables = (list: ScreenStatePressable[]): ScreenStatePressable[] => {
        const seen = new Set<string>();
        return list.filter((p) => {
            const key = `${p.center.x},${p.center.y}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };
    screenState.pressables = dedupPressables(screenState.pressables);
    for (const overlay of screenState.overlays) {
        overlay.pressables = dedupPressables(overlay.pressables);
    }

    // Dedup texts/images: a single visual element often maps to nested host nodes
    // (Image > ExpoImage) or repeated text spans that all measure to the same box.
    const dedupBy = <T extends { center: { x: number; y: number } }>(
        list: T[],
        keyExtra: (item: T) => string
    ): T[] => {
        const seen = new Set<string>();
        return list.filter((item) => {
            const key = `${item.center.x},${item.center.y}|${keyExtra(item)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };
    screenState.texts = dedupBy(screenState.texts, (t) => t.text);

    // Images need geometry-only dedup, not center+src.
    //
    // RN's <Image> and the <ExpoImage> it renders both match IMG_NAME and climb to the
    // same measurable host, but their sources stringify differently — "asset#77" for the
    // required asset, the resolved "http://127.0.0.1:8083/assets/…?unstable_path=…" URL
    // for the inner one. Keying on src therefore treated one picture as two, and every
    // local asset on screen was listed twice at identical coordinates.
    //
    // Keep the more informative source: "asset#N" is an opaque registry index, while the
    // resolved URL carries the actual filename.
    const OPAQUE_ASSET_REF = /^asset#\d+$/;
    const dedupImages = <T extends ScreenStateImage>(list: T[]): T[] => {
        const byBox = new Map<string, T>();
        for (const img of list) {
            const key = `${img.center.x},${img.center.y}|${img.bounds.width}x${img.bounds.height}`;
            const prev = byBox.get(key);
            if (!prev) {
                byBox.set(key, img);
                continue;
            }
            if (OPAQUE_ASSET_REF.test(prev.src ?? "") && !OPAQUE_ASSET_REF.test(img.src ?? "")) {
                byBox.set(key, img);
            }
        }
        return [...byBox.values()];
    };
    screenState.images = dedupImages(screenState.images);
    for (const overlay of screenState.overlays) {
        if (overlay.texts) overlay.texts = dedupBy(overlay.texts, (t) => t.text);
        if (overlay.images) overlay.images = dedupImages(overlay.images);
    }

    // Semantic icon hints + onPress handler hints
    const decorate = (p: ScreenStatePressable & { handler?: unknown; propHandlers?: unknown }) => {
        applyIconHintToLabel(p);
        const direct = describePressHandler(p.handler);
        const hint = direct ? `onPress=${direct}` : describePropHandlers(p.propHandlers);
        if (hint) p.onPressHint = hint;
        delete p.handler;
        delete p.propHandlers;
    };
    screenState.pressables.forEach(decorate);
    for (const overlay of screenState.overlays) {
        overlay.pressables.forEach(decorate);
    }

    // Apply TS-side overlay marking as a safety pass
    for (const overlay of screenState.overlays) {
        if (overlay.pressables.length === 0) continue;
        const minX = Math.min(...overlay.pressables.map((p) => p.bounds.x));
        const minY = Math.min(...overlay.pressables.map((p) => p.bounds.y));
        const maxX = Math.max(...overlay.pressables.map((p) => p.bounds.x + p.bounds.width));
        const maxY = Math.max(...overlay.pressables.map((p) => p.bounds.y + p.bounds.height));
        const overlayBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        markPressablesCoveredByOverlay(screenState.pressables, overlayBounds);
    }

    // Native-presented sheet detection: when an open native sheet covers the screen, its
    // (and the underlying screen's) coordinates are unreliable — flag it and mark the
    // underlying pressables blocked so agents fall back to screenshot/OCR.
    try {
        const parsedRaw = JSON.parse(resolveResult.result || "{}");
        const markers: string[] = Array.isArray(parsedRaw.nativeMarkers) ? parsedRaw.nativeMarkers : [];
        const sheet = detectNativeSheet(markers);
        if (sheet) {
            const note =
                `Native ${sheet.kind} (${sheet.component}) is open — its content is presented outside ` +
                `the RN coordinate space; reported coordinates for it (and the screen behind it) are ` +
                `unreliable. Use ios_screenshot / ocr_screenshot to read and tap it.`;
            screenState.nativeOverlay = { kind: sheet.kind, component: sheet.component, note };
            screenState.notes = [...(screenState.notes ?? []), note];
            // The native sheet dims/blocks the underlying screen — flag root pressables.
            for (const p of screenState.pressables) p.blockedByOverlay = true;
        }
    } catch {
        /* detection is best-effort; never fail the call over it */
    }

    const json = JSON.stringify(screenState, null, 2);
    return { success: true, result: json, screenState };
}
