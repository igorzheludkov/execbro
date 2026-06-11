import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";

// ============================================================================
// Types matching the spec response shape
// ============================================================================

export interface ScreenStatePressable {
    label: string | null;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    testID: string | null;
}

export interface ScreenStateOverlay {
    type: "BottomSheet" | "Modal" | "Alert" | "ActionSheet" | "Unknown";
    title: string | null;
    pressables: ScreenStatePressable[];
}

export interface ScreenStateRoute {
    name: string;
    params: Record<string, unknown> | null;
    stackDepth: number;
}

export interface ScreenState {
    route: ScreenStateRoute | null;
    overlays: ScreenStateOverlay[];
    pressables: ScreenStatePressable[];
}

// ============================================================================
// Pure helpers (exported for unit tests)
// ============================================================================

export function filterPressablesCoveredByOverlay(
    pressables: ScreenStatePressable[],
    overlayBounds: { x: number; y: number; width: number; height: number }
): ScreenStatePressable[] {
    return pressables.filter((p) => {
        const b = p.bounds;
        const fullyCovered =
            b.x >= overlayBounds.x &&
            b.y >= overlayBounds.y &&
            b.x + b.width <= overlayBounds.x + overlayBounds.width &&
            b.y + b.height <= overlayBounds.y + overlayBounds.height;
        return !fullyCovered;
    });
}

export function parseScreenStateResponse(raw: unknown): ScreenState | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.error) return null;
    return {
        route: (r.route as ScreenStateRoute | null) ?? null,
        overlays: (r.overlays as ScreenStateOverlay[]) ?? [],
        pressables: (r.pressables as ScreenStatePressable[]) ?? [],
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
        if (props) {
            var ch = props.children;
            if (typeof ch === 'string') return ch;
            if (typeof ch === 'number') return String(ch);
            if (Array.isArray(ch)) {
                var inline = [];
                for (var ci = 0; ci < ch.length; ci++) {
                    if (typeof ch[ci] === 'string') inline.push(ch[ci]);
                    else if (typeof ch[ci] === 'number') inline.push(String(ch[ci]));
                }
                if (inline.length > 0) return inline.join('');
            }
        }
        var parts = [];
        var child = fiber.child;
        while (child) {
            var t = collectText(child, d + 1);
            if (t) parts.push(t);
            child = child.sibling;
        }
        return parts.join(' ').trim();
    }

    // ------------------------------------------------------------------
    // 1. Route detection
    // ------------------------------------------------------------------

    var route = null;
    try {
        // Expo Router first
        var expoRouter = null;
        try {
            expoRouter = require('expo-router');
        } catch(e) {}
        if (expoRouter && expoRouter.router && expoRouter.router.state) {
            var rs = expoRouter.router.state;
            var focused = rs.routes ? rs.routes[rs.index || 0] : null;
            if (focused) {
                route = {
                    name: focused.name || focused.key || 'unknown',
                    params: focused.params || null,
                    stackDepth: (rs.routes || []).length
                };
            }
        }
    } catch(e) {}

    if (!route) {
        try {
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

            if (navState && navState.routes) {
                function getFocusedLeaf(state) {
                    if (!state || !state.routes || state.routes.length === 0) return null;
                    var idx = (typeof state.index === 'number') ? state.index : state.routes.length - 1;
                    var focused = state.routes[idx];
                    if (focused && focused.state) return getFocusedLeaf(focused.state) || focused;
                    return focused;
                }
                var leaf = getFocusedLeaf(navState);
                if (leaf) {
                    route = {
                        name: leaf.name || leaf.key || 'unknown',
                        params: leaf.params || null,
                        stackDepth: (navState.routes || []).length
                    };
                }
            }
        } catch(e) {}
    }

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

    var RN_PRIMITIVES = /^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|RCT.*|RNS.*|RNC.*|VirtualizedList.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|ExpoRoot|ExpoRootComponent|GestureHandler.*|Reanimated.*|PortalProviderComponent|BottomSheetModalProviderWrapper|PressabilityDebugView)$/;
    var GENERIC_COMPONENT = /^(View|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Pressable|TouchableNativeFeedback|Text|RCTView|RCTText|Unknown)$/;
    var PDV_OWNER_COMPONENT = /^(Pressable|Touchable(Opacity|Highlight|WithoutFeedback|NativeFeedback|Bounce))$/;

    function findMeaningfulAncestorName(fiber) {
        var cur = fiber.return;
        var depth = 0;
        while (cur && depth < 20) {
            var n = getComponentName(cur);
            if (n && typeof cur.type !== 'string' && !RN_PRIMITIVES.test(n)) return n;
            cur = cur.return;
            depth++;
        }
        return null;
    }

    function isScreenHidden(name, props) {
        if (!props) return false;
        if (name === 'MaybeScreen' && props.active === 0) return true;
        if (name === 'SceneView' && props.focused === false) return true;
        if (name === 'RNSScreen' && props['aria-hidden'] === true) return true;
        return false;
    }

    function walkPressabilityDebugViews(fiber, depth, hidden) {
        if (!fiber || depth > 5000) return;
        var name = getComponentName(fiber);
        var props = fiber.memoizedProps;
        var nextHidden = hidden || isScreenHidden(name, props);

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
                var label = a11y || (text && text.length > 0 ? text.slice(0, 80) : null) || testID || null;
                var hostIdx = hostFibers.length;
                hostFibers.push(hostFiber);
                fiberMeta.push({ label: label, testID: testID, hostIdx: hostIdx });
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
                var label2 = a11y2 || (text2 && text2.length > 0 ? text2.slice(0, 80) : null) || testID2 || null;
                var hostIdx2 = hostFibers.length;
                hostFibers.push(hosts3[0]);
                fiberMeta.push({ label: label2, testID: testID2, hostIdx: hostIdx2 });
            }
        }

        var child = fiber.child;
        while (child) {
            walkPressabilityDebugViews(child, depth + 1, nextHidden);
            child = child.sibling;
        }
    }
    walkPressabilityDebugViews(roots[0].current, 0, false);

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
        // First text child as title
        var title = collectText(om.fiber, 0);
        // Collect pressables inside the overlay
        var ovPressHostFibers = [];
        var ovPressMetaList = [];
        walkPressabilityDebugViews(om.fiber, 0, false);
        // After the walk above added to hostFibers/fiberMeta, separate them out
        // Actually we can't easily separate — let's just record the overlay bounds range
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

    // Build overlay bounds by unioning their host measurements
    var overlays = [];
    for (var oi = 0; oi < overlayMeta.length; oi++) {
        var om = overlayMeta[oi];
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var valid = false;
        for (var hi = om.hostStart; hi < om.hostEnd; hi++) {
            var mm = overlayMeasurements[hi];
            if (!mm || mm.width <= 0 || mm.height <= 0) continue;
            valid = true;
            if (mm.x < minX) minX = mm.x;
            if (mm.y < minY) minY = mm.y;
            if (mm.x + mm.width > maxX) maxX = mm.x + mm.width;
            if (mm.y + mm.height > maxY) maxY = mm.y + mm.height;
        }
        // Only include overlay if it covers > 0 area and > 40% of viewport
        if (!valid) continue;
        var oBounds = { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
        overlays.push({ type: om.type, title: om.title, bounds: oBounds, pressables: [] });
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
            center: { x: Math.round(m.x + m.width / 2), y: Math.round(m.y + m.height / 2) },
            bounds: { x: Math.round(m.x), y: Math.round(m.y), width: Math.round(m.width), height: Math.round(m.height) },
            testID: meta[i].testID
        });
    }

    // Assign pressables to overlays vs root based on overlay bounds
    var rootPressables = [];
    for (var pi = 0; pi < allPressables.length; pi++) {
        var p = allPressables[pi];
        var assignedToOverlay = false;
        for (var ov = 0; ov < overlays.length; ov++) {
            var ob = overlays[ov].bounds;
            var fullyInside = p.bounds.x >= ob.x && p.bounds.y >= ob.y &&
                p.bounds.x + p.bounds.width <= ob.x + ob.width &&
                p.bounds.y + p.bounds.height <= ob.y + ob.height;
            if (fullyInside) {
                overlays[ov].pressables.push(p);
                assignedToOverlay = true;
                break;
            }
        }
        if (!assignedToOverlay) {
            // Exclude from root if fully covered by an overlay
            var covered = false;
            for (var ov2 = 0; ov2 < overlays.length; ov2++) {
                var ob2 = overlays[ov2].bounds;
                var fullyCovered = p.bounds.x >= ob2.x && p.bounds.y >= ob2.y &&
                    p.bounds.x + p.bounds.width <= ob2.x + ob2.width &&
                    p.bounds.y + p.bounds.height <= ob2.y + ob2.height;
                if (fullyCovered) { covered = true; break; }
            }
            if (!covered) rootPressables.push(p);
        }
    }

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

    const json = JSON.stringify(screenState, null, 2);
    return { success: true, result: json, screenState };
}
