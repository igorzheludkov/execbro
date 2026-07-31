import type { ExecutionResult } from "./types.js";
import { executeInApp } from "./jsExecute.js";
import { resolveStacksToSource, buildDebugStackHarvestExpression } from "./componentSource.js";
import type { RawComponentStack } from "./componentSource.js";
import { selectionBuffer } from "./selectionBuffer.js";

// ============================================================================
// Coordinate-Based Element Inspection (via DevTools Inspector API)
// ============================================================================

/**
 * Check if the Element Inspector overlay is currently active.
 */
export async function isInspectorActive(device?: string): Promise<boolean> {
    const expression = `
        (function() {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return false;

            let roots = [...(hook.getFiberRoots?.(1) || [])];
            if (roots.length === 0) {
                for (const [id] of (hook.renderers || [])) {
                    roots = [...(hook.getFiberRoots?.(id) || [])];
                    if (roots.length > 0) break;
                }
            }
            if (roots.length === 0) return false;

            function findComponent(fiber, targetName, depth = 0) {
                if (!fiber || depth > 5000) return null;
                const name = fiber.type?.displayName || fiber.type?.name;
                if (name === targetName) return fiber;
                let child = fiber.child;
                while (child) {
                    const found = findComponent(child, targetName, depth + 1);
                    if (found) return found;
                    child = child.sibling;
                }
                return null;
            }

            return !!findComponent(roots[0].current, 'InspectorPanel');
        })()
    `;

    const result = await executeInApp(expression, false, { originatingToolName: "is_inspector_active" }, device);
    if (result.success && result.result) {
        return result.result === "true";
    }
    return false;
}

/**
 * Inspect the React component at a specific (x, y) coordinate.
 *
 * Works on both Paper and Fabric (New Architecture). Walks the fiber tree,
 * fires measureInWindow on each host component, and resolves a Promise once
 * either all callbacks have reported or a 300 ms timeout elapses — then
 * hit-tests against the target coordinates and returns the innermost match.
 *
 * The whole flow happens inside a single Runtime.evaluate with awaitPromise.
 * An earlier two-call design (dispatch → wait 300ms → resolve, bridged via
 * globalThis.__inspectFibers/Measurements) was racy: any JS-context reset
 * between the calls — Fast Refresh full-reload, CDP auto-reconnect landing
 * on a different pageId — wiped the globals and surfaced as the cryptic
 * "No measurement data available. Run inspect_at_point again." error
 * (~13 events / 2 days, all on RN 1.10.0). Collapsing into one call closes
 * that window by construction.
 */
export async function inspectAtPoint(
    x: number,
    y: number,
    options: {
        includeProps?: boolean;
        includeFrame?: boolean;
        device?: string;
    } = {}
): Promise<ExecutionResult> {
    const { includeProps = true, includeFrame = true, device } = options;

    const expression = `
        new Promise(function(resolve) {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return resolve({ error: 'React DevTools hook not available. Make sure you are running a development build.' });

            var roots = [];
            if (hook.getFiberRoots) {
                try { roots = Array.from(hook.getFiberRoots(1) || []); } catch(e) {}
            }
            if (roots.length === 0 && hook.renderers) {
                for (var entry of hook.renderers) {
                    try {
                        var r = Array.from(hook.getFiberRoots ? (hook.getFiberRoots(entry[0]) || []) : []);
                        if (r.length > 0) { roots = r; break; }
                    } catch(e) {}
                }
            }
            if (roots.length === 0) return resolve({ error: 'No fiber roots found. The app may not have rendered yet.' });

            // Paper: measureInWindow is on stateNode directly.
            // Fabric: measureInWindow is on stateNode.canonical.publicInstance.
            function getMeasurable(fiber) {
                var sn = fiber.stateNode;
                if (!sn) return null;
                if (typeof sn.measureInWindow === 'function') return sn;
                if (sn.canonical && sn.canonical.publicInstance &&
                    typeof sn.canonical.publicInstance.measureInWindow === 'function') {
                    return sn.canonical.publicInstance;
                }
                // Fabric leaf nodes like RCTText have no publicInstance. Measure via
                // the native Fabric UIManager using the shadow node instead — needed
                // for text bounds that are tight around the glyphs (not the scroll
                // container the text happens to live inside).
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

            var hostFibers = [];
            function walkFibers(fiber, depth) {
                var cur = fiber;
                while (cur) {
                    if (hostFibers.length >= 500) return;
                    if (typeof cur.type === 'string' && getMeasurable(cur)) hostFibers.push(cur);
                    if (cur.child && depth < 250) walkFibers(cur.child, depth + 1);
                    cur = cur.sibling;
                }
            }
            for (var root of roots) { walkFibers(root.current, 0); }

            if (hostFibers.length === 0) return resolve({ error: 'No measurable host components found. App may not be fully rendered.' });

            var measurements = new Array(hostFibers.length).fill(null);
            var pending = hostFibers.length;
            var settled = false;

            function done() {
                if (settled) return;
                settled = true;
                resolve(buildResult(hostFibers, measurements));
            }

            hostFibers.forEach(function(fiber, i) {
                try {
                    getMeasurable(fiber).measureInWindow(function(fx, fy, fw, fh) {
                        measurements[i] = { x: fx, y: fy, width: fw, height: fh };
                        if (--pending === 0) done();
                    });
                } catch(e) {
                    // Subtract from pending so a throwing measureInWindow doesn't stall the
                    // 'all callbacks fired' path. Slot stays null; hit-test ignores nulls.
                    if (--pending === 0) done();
                }
            });

            // Fallback: some measureInWindow callbacks never fire (off-screen Fabric leaves,
            // detached ScrollView content). Resolve with whatever measurements landed in 300ms.
            setTimeout(done, 300);

            function buildResult(fibers, measurements) {
                var targetX = ${x};
                var targetY = ${y};

            var hits = [];
            for (var i = 0; i < measurements.length; i++) {
                var m = measurements[i];
                if (m && m.width > 0 && m.height > 0 &&
                    targetX >= m.x && targetX <= m.x + m.width &&
                    targetY >= m.y && targetY <= m.y + m.height) {
                    hits.push({ fiber: fibers[i], x: m.x, y: m.y, width: m.width, height: m.height });
                }
            }

            if (hits.length === 0) {
                return { point: { x: targetX, y: targetY }, error: 'No component found at this point. Coordinates may be outside the app bounds or over a native-only element.' };
            }

            // Smallest area = innermost (most specific) component
            hits.sort(function(a, b) { return (a.width * a.height) - (b.width * b.height); });
            var best = hits[0];

            // RN primitives and internal components to skip when surfacing the "element" name.
            // We want the nearest *custom* component, not a library wrapper.
            var RN_PRIMITIVES = /^(View|Text|Image|ScrollView|FlatList|SectionList|TextInput|TouchableOpacity|TouchableHighlight|TouchableNativeFeedback|TouchableWithoutFeedback|Pressable|Button|Switch|ActivityIndicator|SafeAreaView|KeyboardAvoidingView|Animated\\(.*|withAnimated.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|VirtualizedList.*|CellRenderer.*|FrameSizeProvider|MaybeScreenContainer|RCT.*|RNS.*|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|Expo.*|LinearGradient|ViewManagerAdapter_.*|Svg.*|Defs|Path|Rect|Circle|G|Line|Polygon|Polyline|Ellipse|ClipPath|GestureHandler.*|NativeViewGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|MaybeScreen|SafeAreaProvider.*|GestureDetector|PanGestureHandler|DropShadow|BlurView|MaskedView.*)$/;

            function getNearestNamed(fiber, skipPrimitives) {
                var cur = fiber;
                var fallback = null;
                while (cur) {
                    if (cur.type && typeof cur.type !== 'string') {
                        var name = cur.type.displayName || cur.type.name;
                        if (name) {
                            if (!fallback) fallback = { name: name, fiber: cur };
                            if (!skipPrimitives || !RN_PRIMITIVES.test(name)) {
                                return { name: name, fiber: cur };
                            }
                        }
                    }
                    cur = cur.return;
                }
                return fallback;
            }

            function buildPath(fiber) {
                var path = [];
                var cur = fiber;
                while (cur) {
                    if (cur.type) {
                        var n = typeof cur.type === 'string'
                            ? cur.type
                            : (cur.type.displayName || cur.type.name);
                        if (n) path.unshift(n);
                    }
                    cur = cur.return;
                }
                return path.slice(-8).join(' > ');
            }

            // Find nearest custom component (skipping RN primitives) for the element name,
            // but fall back to the nearest named component if nothing custom is found.
            var named = getNearestNamed(best.fiber.return || best.fiber, true);
            var result = {
                point: { x: targetX, y: targetY },
                element: named ? named.name : best.fiber.type,
                nativeElement: best.fiber.type,
                path: buildPath(best.fiber)
            };

            if (${includeFrame}) {
                result.frame = { x: best.x, y: best.y, width: best.width, height: best.height };
            }

            if (${includeProps} && named && named.fiber.memoizedProps) {
                var props = {};
                var keys = Object.keys(named.fiber.memoizedProps);
                for (var i = 0; i < keys.length; i++) {
                    var key = keys[i];
                    if (key === 'children') continue;
                    var val = named.fiber.memoizedProps[key];
                    if (typeof val === 'function') {
                        props[key] = '[Function]';
                    } else if (typeof val === 'object' && val !== null) {
                        try {
                            var str = JSON.stringify(val);
                            props[key] = str.length > 200
                                ? (Array.isArray(val) ? '[Array(' + val.length + ')]' : '[Object]')
                                : val;
                        } catch(e) {
                            props[key] = '[Object]';
                        }
                    } else {
                        props[key] = val;
                    }
                }
                if (Object.keys(props).length > 0) result.props = props;
            }

            // Hierarchy: custom-named component for each hit, deduped, innermost→outermost
            var hierarchy = [];
            for (var j = 0; j < Math.min(hits.length, 15); j++) {
                var n2 = getNearestNamed(hits[j].fiber.return, true) || getNearestNamed(hits[j].fiber, true);
                if (n2 && !hierarchy.some(function(h) { return h.name === n2.name; })) {
                    hierarchy.push({
                        name: n2.name,
                        frame: { x: hits[j].x, y: hits[j].y, width: hits[j].width, height: hits[j].height }
                    });
                }
            }
            if (hierarchy.length > 1) result.hierarchy = hierarchy;

            return result;
            }
        })
    `;

    // awaitPromise:true so CDP Runtime.evaluate returns the resolved value.
    // 5000ms timeout >> the inner 300ms cap; leaves headroom for slow Fabric
    // measure paths without letting a hung Hermes runtime stall the tool.
    return executeInApp(expression, true, { timeoutMs: 5000, originatingToolName: "inspect_at_point" }, device);
}

/**
 * Harvests raw _debugStack strings for whatever sits at (x, y). Returns an
 * empty list rather than throwing, so callers can always fall back to the
 * unenriched payload.
 */
export async function harvestStacksAtPoint(
    x: number,
    y: number,
    device?: string
): Promise<RawComponentStack[]> {
    try {
        const res = await executeInApp(
            buildDebugStackHarvestExpression(x, y),
            true,
            { timeoutMs: 5000, originatingToolName: "inspect_at_point" },
            device
        );
        if (!res.success || !res.result) return [];
        const parsed = JSON.parse(res.result) as { stacks?: RawComponentStack[] };
        return parsed.stacks ?? [];
    } catch {
        return [];
    }
}

/**
 * Attaches source location to an inspector payload. Never throws and never
 * removes existing fields - a failure adds only a `sourceUnavailable` reason.
 */
export async function enrichWithSource(
    payload: Record<string, unknown>,
    stacks: RawComponentStack[]
): Promise<Record<string, unknown>> {
    try {
        const resolved = await resolveStacksToSource(stacks);
        if (resolved.source) {
            return { ...payload, source: resolved.source, ancestors: resolved.ancestors };
        }
        return { ...payload, sourceUnavailable: resolved.sourceUnavailable ?? "unknown" };
    } catch {
        return { ...payload, sourceUnavailable: "resolution-failed" };
    }
}
