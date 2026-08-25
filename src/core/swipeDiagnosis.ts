import { executeInApp, delay } from "./jsExecute.js";
import { SCREEN_SPACE_HELPER_JS, type ScreenSpaceMetrics } from "./screenSpace.js";
import { SHEET_HELPERS_JS } from "./injected/sheetOffset.js";

/**
 * What the scroll surface under a gesture looks like right now.
 *
 * `found` false means no scrollable ancestor sits under the gesture's start point at all —
 * a different answer from "it is at the end", and the one the caller most needs, because it
 * says the coordinates are wrong rather than the content exhausted.
 */
export interface ScrollProbe {
    found: boolean;
    /**
     * The screen could not be inspected at all — no React Native connection, or the
     * app did not answer. Distinct from `found: false`, which is a finding about the
     * screen; this is the absence of one.
     */
    unavailable?: boolean;
    horizontal?: boolean;
    /** Current scroll position along the scrolling axis, in points. */
    offset?: number;
    /** Largest reachable offset: content length minus viewport length. 0 when it all fits. */
    maxOffset?: number;
    /** Component name of the scroll surface, for the message. */
    component?: string | null;
}

/**
 * Run one probe expression, converting every failure mode — a thrown resolver error,
 * a dead connection, a timeout — into `null`. The probe is diagnostic only.
 */
async function probeExec(expression: string, device?: string) {
    try {
        return await executeInApp(expression, false, { timeoutMs: 8000, originatingToolName: "swipe" }, device);
    } catch {
        return null;
    }
}

/**
 * Read the scroll surface under a point.
 *
 * Offset is derived from geometry — the content view's frame against the scroll view's —
 * rather than from a scroll event, because RN keeps no JS-side copy of contentOffset and a
 * gesture that produced no visual change also produced no onScroll to listen for.
 */
export async function probeScrollAt(
    x: number,
    y: number,
    device?: string,
    screenSpace?: ScreenSpaceMetrics
): Promise<ScrollProbe> {
    const dispatch = `
(function() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ found: false });
    var roots = [];
    if (hook.getFiberRoots) roots = Array.from(hook.getFiberRoots(1) || []);
    if (roots.length === 0 && hook.renderers) {
        for (var entry of hook.renderers) {
            var rr = Array.from(hook.getFiberRoots ? (hook.getFiberRoots(entry[0]) || []) : []);
            if (rr.length > 0) { roots = rr; break; }
        }
    }
    if (roots.length === 0) return JSON.stringify({ found: false });

    function nameOf(f) {
        if (!f || !f.type) return null;
        if (typeof f.type === 'string') return f.type;
        return f.type.displayName || f.type.name || null;
    }
    function getMeasurable(f) {
        var sn = f && f.stateNode;
        if (!sn) return null;
        if (typeof sn.measureInWindow === 'function') return sn;
        if (sn.canonical && sn.canonical.publicInstance &&
            typeof sn.canonical.publicInstance.measureInWindow === 'function') {
            return sn.canonical.publicInstance;
        }
        if (sn.node && globalThis.nativeFabricUIManager &&
            typeof globalThis.nativeFabricUIManager.measureInWindow === 'function') {
            var node = sn.node;
            return { measureInWindow: function(cb) {
                try { globalThis.nativeFabricUIManager.measureInWindow(node, cb); } catch (e) {}
            } };
        }
        return null;
    }
    function firstHost(f, d) {
        if (!f || d > 10) return null;
        if (typeof f.type === 'string' && getMeasurable(f)) return f;
        var c = f.child;
        while (c) { var h = firstHost(c, d + 1); if (h) return h; c = c.sibling; }
        return null;
    }

    // Match the HOST fiber, not the JS component.
    //
    // Matching component names by regex picked up VirtualizedListContext — a context
    // provider, whose "first host below" and "that host's first child" are unrelated views,
    // so the geometry it produced was meaningless and the verdict confidently wrong. The
    // host is unambiguous: RN renders exactly one scroll host per scroll surface, and its
    // first host child is the content view whose offset we need.
    ${SHEET_HELPERS_JS}
    var SCROLL_HOST = /^(RCTScrollView|AndroidHorizontalScrollView|AndroidHorizontalScrollContentView|RCTScrollViewComponentView)$/;
    var candidates = [];
    (function walk(f, d) {
        if (!f || d > 4000) return;
        if (typeof f.type === 'string' && SCROLL_HOST.test(f.type)) {
            var content = f.child ? firstHost(f.child, 0) : null;
            if (content && getMeasurable(f)) {
                // horizontal lives on the owning React component, a few levels up.
                var horizontal = false;
                var owner = f.return, up = 0, ownerName = f.type;
                while (owner && up < 6) {
                    var op = owner.memoizedProps;
                    if (op && op.horizontal === true) { horizontal = true; }
                    var on = nameOf(owner);
                    if (on && /^(FlatList|SectionList|ScrollView|VirtualizedList)$/.test(on)) {
                        ownerName = on;
                        break;
                    }
                    owner = owner.return; up++;
                }
                candidates.push({ host: f, content: content, horizontal: horizontal, name: ownerName });
            }
        }
        var c = f.child;
        while (c) { walk(c, d + 1); c = c.sibling; }
    })(roots[0].current, 0);

    globalThis.__swipeProbe = candidates.map(function(c) {
        return { horizontal: c.horizontal, name: c.name, layout: null, content: null, sheet: null };
    });
    // The window rect, for the sheet correction below. A scroll surface on a
    // modally-presented screen measures from the sheet's own container, so without
    // this the probe compares the caller's screen coordinate against a frame that
    // is short by the inset and reports "no scroll view there" — about a screen it
    // did in fact see.
    globalThis.__swipeProbeViewport = null;
    try {
        var vpHost = firstHost(roots[0].current, 0);
        if (vpHost) {
            getMeasurable(vpHost).measureInWindow(function(mx, my, mw, mh) {
                globalThis.__swipeProbeViewport = { width: mw, height: mh + (my > 0 ? my : 0) };
            });
        }
    } catch (e) {}
    for (var i = 0; i < candidates.length; i++) {
        (function(idx) {
            try {
                var bnd = modalBoundaryOf(candidates[idx].host);
                if (bnd) {
                    getMeasurable(bnd).measureInWindow(function(mx, my, mw, mh) {
                        globalThis.__swipeProbe[idx].sheet = { x: mx, y: my, width: mw, height: mh };
                    });
                }
            } catch (e) {}
            try {
                getMeasurable(candidates[idx].host).measureInWindow(function(mx, my, mw, mh) {
                    globalThis.__swipeProbe[idx].layout = { x: mx, y: my, width: mw, height: mh };
                });
            } catch (e) {}
            try {
                getMeasurable(candidates[idx].content).measureInWindow(function(mx, my, mw, mh) {
                    globalThis.__swipeProbe[idx].content = { x: mx, y: my, width: mw, height: mh };
                });
            } catch (e) {}
        })(i);
    }
    return JSON.stringify({ dispatched: candidates.length });
})()`;

    // The gesture has already been delivered by the time this runs — `swipe` drives
    // adb/simctl and needs no RN connection, while this probe reads the fiber tree and
    // does. `executeInApp` throws (not returns) when an explicit device matches no
    // connected app, so an optional explanation was replacing a successful swipe with
    // an error on any non-RN screen. Enrichment never fails the thing it describes.
    const dispatched = await probeExec(dispatch, device);
    if (!dispatched) return { found: false, unavailable: true };
    if (!dispatched.success) return { found: false, unavailable: true };

    await delay(250);

    const resolve = `
(function() {
    ${SCREEN_SPACE_HELPER_JS}
    ${SHEET_HELPERS_JS}
    var SCREEN_SPACE = ${JSON.stringify(screenSpace ?? { platform: "ios", topInset: 0 })};
    var probes = globalThis.__swipeProbe || [];
    var viewport = globalThis.__swipeProbeViewport;
    globalThis.__swipeProbe = null;
    globalThis.__swipeProbeViewport = null;

    // The caller's coordinates are delivered-screenshot pixels — the space every tool
    // speaks — while measureInWindow answers in points/dp and, on Android, from below the
    // status bar. Hit-testing without this conversion compares two different spaces and
    // misses by the device scale: on a 420dpi phone a point inside the list read as being
    // outside every scroll view, and the diagnosis confidently said there was none.
    var PX = scaleOf(SCREEN_SPACE);
    var px = ${Math.round(x)} / PX, py = ${Math.round(y)} / PX;

    var best = null;
    for (var i = 0; i < probes.length; i++) {
        var p = probes[i];
        if (!p.layout || !p.content) continue;
        var L = p.layout;
        if (L.width <= 0 || L.height <= 0) continue;
        // Sheet correction first, band rule second — see injected/sheetOffset.ts.
        var ly = L.y + sheetShiftY(p.sheet, viewport);
        if (SCREEN_SPACE.topInset > 0) ly = toScreenSpaceY(ly, SCREEN_SPACE);
        if (px < L.x || px > L.x + L.width || py < ly || py > ly + L.height) continue;
        // Innermost wins: later entries are deeper in the DFS.
        best = p;
    }
    if (!best) return JSON.stringify({ found: false });
    var L = best.layout, C = best.content;
    var offset = best.horizontal ? (L.x - C.x) : (L.y - C.y);
    var span = best.horizontal ? (C.width - L.width) : (C.height - L.height);
    return JSON.stringify({
        found: true,
        horizontal: best.horizontal,
        offset: Math.round(offset),
        maxOffset: Math.round(span > 0 ? span : 0),
        component: best.name
    });
})()`;

    const resolved = await probeExec(resolve, device);
    if (!resolved || !resolved.success || !resolved.result) return { found: false, unavailable: true };
    try {
        return JSON.parse(resolved.result) as ScrollProbe;
    } catch {
        return { found: false };
    }
}

/** Treat offsets this close to a limit as being at it — subpixel layout never lands exactly. */
const EDGE_TOLERANCE_PX = 2;

/**
 * Turn a no-op swipe into the one sentence that says which no-op it was.
 *
 * The old text offered three possibilities at once — end-of-scroll, non-scrollable, or a
 * missed surface — and left the reader to tell them apart by hand, every time. The runtime
 * knows: it has the offset and the content size.
 */
export function explainNoOpSwipe(
    probe: ScrollProbe,
    start: { x: number; y: number },
    gesture?: { dx: number; dy: number }
): string {
    if (probe.unavailable) {
        return `the swipe was delivered, but the screen could not be inspected to say why nothing moved — no React Native connection to this device. Take a screenshot to see the result, or run scan_metro if this is an RN app.`;
    }
    if (!probe.found) {
        return `no scroll view found under (${Math.round(start.x)}, ${Math.round(start.y)}) — the gesture did not land on a scrollable surface. Take a screenshot or call get_screen_state, then aim at the list itself.`;
    }

    const axis = probe.horizontal ? "horizontally" : "vertically";
    const where = probe.component ? `<${probe.component} />` : "the scroll view";
    const offset = probe.offset ?? 0;
    const maxOffset = probe.maxOffset ?? 0;

    // Axis mismatch first: it explains the no-op completely, and every other verdict below
    // would describe a state the gesture was never going to change anyway.
    if (gesture) {
        const gestureHorizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy);
        if (gestureHorizontal !== !!probe.horizontal) {
            return `the gesture is ${gestureHorizontal ? "horizontal" : "vertical"} but ${where} scrolls ${axis} — wrong axis, so nothing could move. Swipe ${probe.horizontal ? "left/right" : "up/down"} instead.`;
        }
    }

    if (maxOffset <= 0) {
        return `${where} is not scrollable ${axis} — its content fits the viewport, so there is nothing to scroll to.`;
    }
    if (offset <= EDGE_TOLERANCE_PX) {
        return `offset unchanged at 0 — ${where} is already at the top. Swipe the other direction to move.`;
    }
    if (offset >= maxOffset - EDGE_TOLERANCE_PX) {
        return `offset unchanged at ${offset} (max) — ${where} is already at the end. There is no more content this way.`;
    }
    return `offset unchanged at ${offset} of ${maxOffset} — ${where} is mid-scroll and did not move, so the gesture did not reach it (another surface may be on top, or scrolling is disabled).`;
}
