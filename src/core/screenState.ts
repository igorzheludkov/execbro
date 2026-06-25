import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";
import { iconSemanticHint } from "./iconSemantics.js";

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
    /** Nearest standalone text (row sibling preferred) when the pressable has no label of its own. */
    nearbyText?: string | null;
    /** True when an overlay fully covers this root pressable — taps will not reach it. */
    blockedByOverlay?: boolean;
    /** What pressing triggers: "onPress=handleSubmit()", "onBack=goBack()", or "onPress→onBack" (prop route when the fn is anonymous). Absent when nothing meaningful survives Hermes. */
    onPressHint?: string | null;
}

export interface ScreenStateText {
    text: string;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    blockedByOverlay?: boolean;
}

export interface ScreenStateImage {
    src?: string | null;
    alt?: string | null;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    blockedByOverlay?: boolean;
}

export interface ScreenStateOverlay {
    type: "BottomSheet" | "Modal" | "Alert" | "ActionSheet" | "Unknown";
    title: string | null;
    pressables: ScreenStatePressable[];
    texts?: ScreenStateText[];
    images?: ScreenStateImage[];
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
    return `  (${center.x}, ${center.y}) 📝 "${body}" frame:(${frame.x},${frame.y} ${frame.width}x${frame.height})`;
}

/** One merged-list line for an image node — coordinates match pressable lines. */
export function formatImageEntry(
    img: ScreenStateImage,
    convert: ItemCoordConverter = identityCoords
): string {
    const { center, frame } = convert(img);
    const src = img.src ? ` src="${truncate(img.src, IMAGE_SRC_DISPLAY_MAX)}"` : "";
    const alt = img.alt ? ` alt="${img.alt}"` : "";
    return `  (${center.x}, ${center.y}) 🖼 Image ${frame.width}x${frame.height}${src}${alt} frame:(${frame.x},${frame.y} ${frame.width}x${frame.height})`;
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
export function formatScreenStateSummary(
    ss: ScreenState,
    convert: ItemCoordConverter = identityCoords,
    opts: { pressablesOnly?: boolean; fullText?: boolean } = {}
): string {
    const lines: string[] = [];
    if (ss.route) {
        lines.push(`📍 Currently focused screen: "${ss.route.name}"  [navigation stack: ${ss.route.stack.join(" > ")}]`);
        if (ss.route.params && Object.keys(ss.route.params).length > 0) {
            const params = JSON.stringify(ss.route.params);
            lines.push(`   route params: ${params.length > 600 ? params.slice(0, 600) + "…" : params}`);
        }
    } else {
        lines.push("📍 Currently focused screen: unknown (no React Navigation / Expo Router detected)");
    }
    const formatPressable = (p: ScreenStatePressable) => {
        const { center, frame } = convert(p);
        return `  (${center.x}, ${center.y})${p.component ? ` <${p.component} />` : ""} ${p.label ? `"${p.label}"` : "(unlabeled)"}` +
            `${p.nearbyText ? ` near "${p.nearbyText}"` : ""}${p.onPressHint ? ` ${p.onPressHint}` : ""}` +
            `${p.testID ? ` testID="${p.testID}"` : ""}${p.isInput ? " [input]" : ""}` +
            ` frame:(${frame.x},${frame.y} ${frame.width}x${frame.height})`;
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

    if (ss.overlays.length > 0) {
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
        lines.push(`\n🎯 Root pressables: ${reachableP.length > 0 ? "" : "(none reachable)"}`);
        renderGroup(reachableP, reachableT, reachableI).forEach((l) => lines.push(l));
        if (blockedP.length > 0 || blockedT.length > 0 || blockedI.length > 0) {
            lines.push(`\n🚫 Blocked by overlay (visible on the underlying screen but taps will NOT reach them until the overlay closes):`);
            renderGroup(blockedP, blockedT, blockedI).forEach((l) => lines.push(l));
        }
    } else {
        lines.push("\n🎯 Pressables:");
        const body = renderGroup(ss.pressables, ss.texts, ss.images);
        if (body.length > 0) body.forEach((l) => lines.push(l));
        else lines.push("  (none)");
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
    var overlayFiberMeta = []; // { type, fiberRoot, hostFibers }

    function classifyOverlay(name) {
        if (name === 'Modal') return 'Modal';
        if (name === 'Alert') return 'Alert';
        if (/ActionSheet/i.test(name)) return 'ActionSheet';
        if (/BottomSheet/i.test(name)) return 'BottomSheet';
        return 'Unknown';
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

        // Heuristic: absolute-positioned node with high zIndex covering > 40% screen
        // Only fires if it has at least one pressable child
        if (typeof fiber.type === 'string') {
            var style = props.style;
            if (style && typeof style === 'object' && !Array.isArray(style)) {
                if ((style.zIndex > 999 || style.position === 'absolute') &&
                    typeof style.width === 'number' && typeof style.height === 'number') {
                    if (viewportW < 9999) {
                        var area = style.width * style.height;
                        var vArea = viewportW * viewportH;
                        if (area > vArea * 0.4) {
                            // Check if it has a pressable child
                            var hasPressable = false;
                            (function checkPress(f, d) {
                                if (!f || d > 10 || hasPressable) return;
                                if (f.memoizedProps && typeof f.memoizedProps.onPress === 'function') { hasPressable = true; return; }
                                checkPress(f.child, d + 1);
                                if (!hasPressable) checkPress(f.sibling, d);
                            })(fiber.child, 0);
                            if (hasPressable) {
                                var hosts2 = [];
                                findHostsInSubtree(fiber, 0, hosts2, 64);
                                if (hosts2.length > 0) {
                                    overlayFiberMeta.push({ type: 'Unknown', fiber: fiber, hostFibers: hosts2 });
                                }
                                return;
                            }
                        }
                    }
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
    // A count badge ("1", "99+") is the only text on icon buttons like a cart — treat it
    // as no-own-label so the icon child still surfaces (the count is kept as nearby text).
    var COUNT_BADGE = /^\\d{1,3}\\+?$/;

    var RN_PRIMITIVES = /^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|ScrollViewContext(Base)?|VirtualizedListContext(Resetter)?|TextInputContext|KeyboardAvoidingViewContext|RCT.*|RNS.*|RNC.*|ViewManagerAdapter_.*|VirtualizedList.*|CellRenderer.*|FrameSizeProvider.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|SafeAreaProvider.*|SafeAreaFrameContext|SafeAreaInsetsContext|ExpoRoot|ExpoRootComponent|GestureHandler.*|NativeViewGestureHandler|GestureDetector|PanGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|KeyboardProvider|PortalProviderComponent|BottomSheetModalProviderWrapper|ThemeContext|ThemeProvider|TextAncestorContext|PressabilityDebugView|TouchableHighlightImpl|StatusBarOverlay|BottomSheetHostingContainerComponent|BottomSheetGestureHandlersProvider|BottomSheetBackdropContainerComponent|BottomSheetContainerComponent|BottomSheetDraggableViewComponent|BottomSheetHandleContainerComponent|BottomSheetBackgroundContainerComponent|DebuggingOverlay|InspectorDeferred|Inspector|InspectorOverlay|InspectorPanel|StyleInspector|BoxInspector|BoxContainer|ElementBox|BorderBox|InspectorPanelButton)$/;
    var GENERIC_COMPONENT = /^(View|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Pressable|TouchableNativeFeedback|Text|RCTView|RCTText|Unknown)$/;
    var PDV_OWNER_COMPONENT = /^(Pressable|Touchable(Opacity|Highlight|WithoutFeedback|NativeFeedback|Bounce))$/;

    var PAGE_COMPONENT = /^(.*Screen|.*Page|.*View$|.*Container$|.*Layout$|.*Root$|ExpoRoot|App$)/;

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
        return cf ? getComponentName(cf) : null;
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

    function isScreenHidden(name, props) {
        if (!props) return false;
        if (name === 'MaybeScreen' && props.active === 0) return true;
        if (name === 'SceneView' && props.focused === false) return true;
        if (name === 'RNSScreen' && props['aria-hidden'] === true) return true;
        return false;
    }

    function walkPressabilityDebugViews(fiber, depth, hidden, ovIdx) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps;
        var nextHidden = hidden || isScreenHidden(name, props);

        // Track which overlay subtree we're inside — membership by ancestry, not
        // geometry. A bottom sheet's subtree includes a full-screen backdrop, so
        // geometric containment wrongly swallows the underlying screen's pressables.
        if (ovIdx == null) {
            for (var ofi = 0; ofi < overlayFiberMeta.length; ofi++) {
                if (overlayFiberMeta[ofi].fiber === fiber) { ovIdx = ofi; break; }
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
                fiberMeta.push({ label: label, testID: testID, hostIdx: hostIdx, icon: icon, overlayIdx: ovIdx, component: resolveComponentName(pressableFiber), hasOwnLabel: !!baseLabel, handler: pressFn ? handlerHint(pressFn) : null, propHandlers: collectPropHandlers(pressableFiber, pressFn) });
            }
            return;
        }

        // Fallback: onPress-based detection when PDV not present (production builds)
        if (!nextHidden && props && typeof props.onPress === 'function') {
            var hosts3 = [];
            findHostsInSubtree(fiber, 0, hosts3, 8);
            if (hosts3.length > 0) {
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
                fiberMeta.push({ label: label2, testID: testID2, hostIdx: hostIdx2, icon: icon2, overlayIdx: ovIdx, component: resolveComponentName(fiber), hasOwnLabel: !!baseLabel2, handler: handlerHint(props.onPress), propHandlers: collectPropHandlers(fiber, props.onPress) });
            }
        }

        // TextInputs — not covered by PressabilityDebugView or onPress. Label falls
        // back to the placeholder so empty form fields stay identifiable.
        if (!nextHidden && props && typeof props.onPress !== 'function' &&
            (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function')) {
            var hostsI = [];
            findHostsInSubtree(fiber, 0, hostsI, 8);
            if (hostsI.length > 0) {
                var pI = fiber.memoizedProps || {};
                var textI = collectText(fiber, 0);
                var placeholderI = (typeof pI.placeholder === 'string' && pI.placeholder.length > 0) ? pI.placeholder : null;
                var testIDI = pI.testID || pI.nativeID || null;
                var baseLabelI = pI.accessibilityLabel || (textI && textI.length > 0 ? textI.slice(0, 80) : null) || (placeholderI ? placeholderI.slice(0, 80) : null) || null;
                var labelI = resolveLabel(fiber, hostsI[0], baseLabelI, testIDI);
                var iconI = baseLabelI ? null : findMeaningfulChildName(fiber);
                var hostIdxI = hostFibers.length;
                hostFibers.push(hostsI[0]);
                fiberMeta.push({ label: labelI, testID: testIDI, hostIdx: hostIdxI, icon: iconI, overlayIdx: ovIdx, component: resolveComponentName(fiber), isInput: true, hasOwnLabel: !!baseLabelI });
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

    function walkTexts(fiber, depth, insidePressable, inHidden) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps;
        var nextHidden = inHidden || isScreenHidden(name, props);

        var hasOnPress = props && typeof props.onPress === 'function';
        var isInputHere = props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');
        var nextInside = insidePressable || !!hasOnPress || !!isInputHere;

        // Record standalone text when outside any pressable — its own text already
        // labels the pressable it belongs to. Climb to the nearest measurable host
        // for proxy bounds (Fabric RCTText has no publicInstance).
        if (!insidePressable && !nextHidden && name !== 'RCTText' && typeof fiber.type !== 'string') {
            var str = extractTextString(fiber);
            if (str && str.length > 0 && str.length <= 120) {
                var up = fiber;
                var upDepth = 0;
                var measurableT = null;
                while (up && upDepth < 20) {
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
                }
            }
        }

        var child = fiber.child;
        while (child) {
            walkTexts(child, depth + 1, nextInside, nextHidden);
            child = child.sibling;
        }
    }
    walkTexts(roots[0].current, 0, false, false);

    // ------------------------------------------------------------------
    // 4. Store everything in globalThis for the resolve call
    // ------------------------------------------------------------------

    // Store overlay host fibers separately
    var overlayHostFibers = [];
    var overlayMetaList = overlayFiberMeta.map(function(om) {
        var startIdx = overlayHostFibers.length;
        for (var hi = 0; hi < om.hostFibers.length; hi++) {
            overlayHostFibers.push(om.hostFibers[hi]);
        }
        var title = collectText(om.fiber, 0);
        return {
            type: om.type,
            title: (title && title.length > 2) ? title.slice(0, 60) : null,
            hostStart: startIdx,
            hostEnd: overlayHostFibers.length
        };
    });

    // Measure root for viewport
    var rootIdx = -1;
    if (rootHostFiber) {
        rootIdx = hostFibers.length;
        hostFibers.push(rootHostFiber);
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

    return { count: hostFibers.length, overlayCount: overlayFiberMeta.length };
})()
    `;

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000, originatingToolName: "get_screen_state" }, device);
    if (!dispatchResult.success) return dispatchResult;

    try {
        const dp = JSON.parse(dispatchResult.result || "{}");
        if (dp.error) return { success: false, error: dp.error };
    } catch { /* ignore */ }

    await delay(300);

    const resolveExpression = `
(function() {
    var hostFibers = globalThis.__screenStateFibers;
    var meta = globalThis.__screenStateMeta;
    var measurements = globalThis.__screenStateMeasurements;
    var rootIdx = globalThis.__screenStateRootIdx;
    var route = globalThis.__screenStateRoute;
    var overlayMeta = globalThis.__screenStateOverlayMeta || [];
    var overlayMeasurements = globalThis.__screenStateOverlayMeasurements || [];
    var textContents = globalThis.__screenStateTextContents || [];
    var textMeasurements = globalThis.__screenStateTextMeasurements || [];
    globalThis.__screenStateTextContents = null;
    globalThis.__screenStateTextMeasurements = null;
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
            var mm = overlayMeasurements[hi];
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
        var blockBounds = { x: Math.round(bMinX), y: Math.round(bMinY), width: Math.round(bMaxX - bMinX), height: Math.round(bMaxY - bMinY) };
        // When every host is backdrop-sized (gorhom sheets measure only full-screen
        // containers), there is no usable content rect — geometric fallback would
        // swallow the underlying screen's pressables, so it is disabled (hasContent).
        var contentBounds = cValid
            ? { x: Math.round(cMinX), y: Math.round(cMinY), width: Math.round(cMaxX - cMinX), height: Math.round(cMaxY - cMinY) }
            : blockBounds;
        overlays.push({ origIdx: oi, type: om.type, title: om.title, blockBounds: blockBounds, contentBounds: contentBounds, hasContent: cValid, pressables: [] });
    }

    // Build pressable list
    var allPressables = [];
    for (var i = 0; i < meta.length; i++) {
        if (i === rootIdx) continue;
        var m = measurements[i];
        if (!m || m.width <= 0 || m.height <= 0) continue;
        if (m.x + m.width < 0 || m.y + m.height < 0) continue;
        if (m.x > viewportW || m.y > viewportH) continue;
        allPressables.push({
            label: meta[i].label,
            component: meta[i].component || null,
            center: { x: Math.round(m.x + m.width / 2), y: Math.round(m.y + m.height / 2) },
            bounds: { x: Math.round(m.x), y: Math.round(m.y), width: Math.round(m.width), height: Math.round(m.height) },
            testID: meta[i].testID,
            icon: meta[i].icon || null,
            isInput: !!meta[i].isInput,
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
        var tm = textMeasurements[tmi];
        var tc = textContents[tmi];
        if (!tm || !tc || tm.width <= 0 || tm.height <= 0) continue;
        if (tm.x + tm.width < 0 || tm.y + tm.height < 0) continue;
        if (tm.x > viewportW || tm.y > viewportH) continue;
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
                if (inside(p.bounds, overlays[ov2].blockBounds)) { p.blockedByOverlay = true; break; }
            }
            rootPressables.push(p);
        }
    }
    for (var si = 0; si < allPressables.length; si++) {
        delete allPressables[si].overlayIdx;
        delete allPressables[si].hasOwnLabel;
    }

    // Sort visually (top-to-bottom, left-to-right) — walk order is mount order,
    // which puts late-mounted overlays like floating headers at the end.
    function byPosition(a, b) {
        if (a.center.y !== b.center.y) return a.center.y - b.center.y;
        return a.center.x - b.center.x;
    }
    rootPressables.sort(byPosition);
    for (var so = 0; so < overlays.length; so++) overlays[so].pressables.sort(byPosition);

    // Strip bounds from overlay objects (not in public interface)
    var cleanOverlays = overlays.map(function(o) {
        return { type: o.type, title: o.title, pressables: o.pressables };
    });

    return { route: route, overlays: cleanOverlays, pressables: rootPressables };
})()
    `;

    const resolveResult = await executeInApp(resolveExpression, false, { timeoutMs: 15000, originatingToolName: "get_screen_state" }, device);

    if (!resolveResult.success) return resolveResult;

    let screenState: ScreenState | undefined;
    try {
        const parsed = JSON.parse(resolveResult.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
        screenState = parseScreenStateResponse(parsed) ?? undefined;
    } catch {
        return { success: false, error: "Failed to parse screen state response" };
    }

    if (!screenState) return { success: false, error: "Empty screen state response" };

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

    const json = JSON.stringify(screenState, null, 2);
    return { success: true, result: json, screenState };
}
