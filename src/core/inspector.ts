import type { ExecutionResult } from "./types.js";
import { executeInApp } from "./jsExecute.js";
import { resolveStacksToSource, buildDebugStackHarvestExpression } from "./componentSource.js";
import type { RawComponentStack } from "./componentSource.js";
import { RN_PRIMITIVES_SRC, GENERIC_COMPONENT_SRC } from "./injectedFilters.js";

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

            // Collection bounds. These exist only to stop a pathological/cyclic tree from
            // hanging the runtime — they must NOT bite on real screens. The previous values
            // (500 hosts / depth 250) did: on a mid-size Expo app 45% of measurable hosts fell
            // outside them (914 -> 500), and because the hit-test then silently ran against the
            // survivors, inspect_at_point returned components from the screen *underneath* an
            // open modal. Real measurements: test-app 200 hosts / depth 255, AppA 201 / 252,
            // AppB 914 / 281. Anything that trips these limits now reports it.
            var MAX_HOSTS = 20000;
            var MAX_DEPTH = 2000;
            var truncatedByCount = false;
            var truncatedByDepth = false;

            var hostFibers = [];
            function walkFibers(fiber, depth) {
                var cur = fiber;
                while (cur) {
                    if (hostFibers.length >= MAX_HOSTS) { truncatedByCount = true; return; }
                    if (typeof cur.type === 'string' && getMeasurable(cur)) hostFibers.push(cur);
                    if (cur.child) {
                        if (depth < MAX_DEPTH) walkFibers(cur.child, depth + 1);
                        else truncatedByDepth = true;
                    }
                    cur = cur.sibling;
                }
            }
            for (var root of roots) { walkFibers(root.current, 0); }

            if (hostFibers.length === 0) return resolve({ error: 'No measurable host components found. App may not be fully rendered.' });

            // Index fibers so the named element's own frame can be resolved later.
            var hostIndex = new Map();
            for (var hi = 0; hi < hostFibers.length; hi++) hostIndex.set(hostFibers[hi], hi);

            var measurements = new Array(hostFibers.length).fill(null);
            var pending = hostFibers.length;
            var settled = false;
            var timedOut = false;

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
            // detached ScrollView content). Scale the budget with the node count so lifting the
            // 500-host cap doesn't just convert a truncation into a timeout — a flat 300ms was
            // ample for 200 nodes but is not for 900+. Still far below the 8s outer timeout.
            var measureBudgetMs = Math.min(3000, 400 + hostFibers.length * 2);
            setTimeout(function() { timedOut = true; done(); }, measureBudgetMs);

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

            // Shared with screenState/inputTarget via injectedFilters.ts. This file used to carry
            // its own divergent copy that listed Pressable/TextInput/View as skippable, so the
            // climb walked straight past the very components holding onPress/testID and landed on
            // a context provider — reporting ScrollViewContext with props {value:{horizontal:false}}
            // for a button. Keep these imported; do not re-inline them.
            var RN_PRIMITIVES = ${RN_PRIMITIVES_SRC};
            var GENERIC_COMPONENT = ${GENERIC_COMPONENT_SRC};

            function isInteractive(fiber) {
                var p = fiber.memoizedProps;
                if (!p || typeof p !== 'object') return false;
                return typeof p.onPress === 'function'
                    || typeof p.onLongPress === 'function'
                    || typeof p.onChangeText === 'function'
                    || p.testID !== undefined
                    || p.accessibilityRole === 'button';
            }

            // Pick the component a human would say they touched.
            //
            // Priority: the nearest interactive fiber (onPress/testID/...), then — because the
            // handler usually lives on a generic TouchableOpacity inside a meaningful wrapper —
            // keep climbing a few levels for a custom component that owns it. That yields
            // ListItemRow over TouchableOpacity in a component-driven app, while still yielding
            // Pressable (not a far-away screen component) in an app built from bare primitives.
            var CUSTOM_LOOKAHEAD = 6;
            function isCustomName(name) {
                return !RN_PRIMITIVES.test(name) && !GENERIC_COMPONENT.test(name);
            }
            function namedOf(fiber) {
                if (!fiber || !fiber.type || typeof fiber.type === 'string') return null;
                var n = fiber.type.displayName || fiber.type.name;
                return n ? { name: n, fiber: fiber } : null;
            }
            function pickElement(startFiber) {
                var cur = startFiber;
                var interactive = null;
                var firstCustom = null;
                var anyNamed = null;
                var steps = 0;
                while (cur && steps < 40) {
                    var nd = namedOf(cur);
                    if (nd) {
                        if (!anyNamed) anyNamed = nd;
                        if (!firstCustom && isCustomName(nd.name)) firstCustom = nd;
                        if (!interactive && isInteractive(cur)) { interactive = nd; break; }
                    }
                    cur = cur.return;
                    steps++;
                }

                if (interactive) {
                    // The handler usually sits on a generic TouchableOpacity/Pressable inside the
                    // component that gives it meaning. Climb from the interactive node (NOT from
                    // the hit node) for that owner: searching from the hit node instead would
                    // latch onto an unrelated custom child on the way up — e.g. picking the
                    // ThemedText label rather than the RoleButton that owns the press.
                    var up = interactive.fiber;
                    var upSteps = 0;
                    while (up && upSteps <= CUSTOM_LOOKAHEAD) {
                        var und = namedOf(up);
                        if (und && isCustomName(und.name)) return und;
                        up = up.return;
                        upSteps++;
                    }
                    return interactive;
                }
                return firstCustom || anyNamed;
            }

            // Frame of the named element itself = its nearest measured host descendant.
            // Previously the reported frame was the innermost hit host while the element name and
            // props came from an ancestor, so the two described different boxes and any tap target
            // computed from the frame was wrong.
            function frameOfNamed(namedFiber) {
                var found = null;
                (function down(f, d) {
                    if (found || !f || d > 40) return;
                    var idx = hostIndex.get(f);
                    if (idx !== undefined && measurements[idx]) { found = measurements[idx]; return; }
                    var c = f.child;
                    while (c && !found) { down(c, d + 1); c = c.sibling; }
                })(namedFiber, 0);
                return found;
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

            // Start at the hit fiber itself, not its parent: the hit host can be the interactive
            // node, and starting at .return made that unreachable.
            var named = pickElement(best.fiber);
            var result = {
                point: { x: targetX, y: targetY },
                element: named ? named.name : best.fiber.type,
                nativeElement: best.fiber.type,
                path: buildPath(best.fiber)
            };

            if (${includeFrame}) {
                var namedFrame = named ? frameOfNamed(named.fiber) : null;
                var elFrame = namedFrame || best;
                result.frame = { x: elFrame.x, y: elFrame.y, width: elFrame.width, height: elFrame.height };
                // The innermost host actually hit, when it differs from the element's own box.
                if (namedFrame && (namedFrame.x !== best.x || namedFrame.y !== best.y ||
                    namedFrame.width !== best.width || namedFrame.height !== best.height)) {
                    result.hitFrame = { x: best.x, y: best.y, width: best.width, height: best.height };
                }
            }

            if (truncatedByCount || truncatedByDepth || (timedOut && pending > 0)) {
                result.incomplete = {
                    reason: truncatedByCount ? 'host-limit' : (truncatedByDepth ? 'depth-limit' : 'measure-timeout'),
                    hostsCollected: hostFibers.length,
                    measurementsMissing: pending > 0 ? pending : 0,
                    note: 'Result may be inaccurate: some on-screen nodes were not measured, so the hit-test could resolve to an outer or occluded element.'
                };
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

            // Hierarchy: the hit element's real ancestor chain, innermost→outermost.
            //
            // This used to be built from *other hits* — every measured node containing the point,
            // each mapped to its nearest named component. Those hits are not necessarily
            // ancestors of the element: with a modal open, nodes from the screen underneath also
            // contain the point, so the chain interleaved ancestors from two different screens.
            // Walking .return keeps it to genuine ancestors.
            var hierarchy = [];
            var seenNames = {};
            var hcur = named ? named.fiber : best.fiber;
            while (hcur && hierarchy.length < 15) {
                if (hcur.type && typeof hcur.type !== 'string') {
                    var hname = hcur.type.displayName || hcur.type.name;
                    if (hname && !RN_PRIMITIVES.test(hname) && !seenNames[hname]) {
                        seenNames[hname] = true;
                        var hframe = frameOfNamed(hcur);
                        hierarchy.push(hframe
                            ? { name: hname, frame: { x: hframe.x, y: hframe.y, width: hframe.width, height: hframe.height } }
                            : { name: hname });
                    }
                }
                hcur = hcur.return;
            }
            if (hierarchy.length > 1) result.hierarchy = hierarchy;

            return result;
            }
        })
    `;

    // awaitPromise:true so CDP Runtime.evaluate returns the resolved value.
    // 8000ms outer timeout sits above the inner measure budget (up to 3000ms on very large
    // screens) with headroom for slow Fabric measure paths, without letting a hung Hermes
    // runtime stall the tool.
    return executeInApp(expression, true, { timeoutMs: 8000, originatingToolName: "inspect_at_point" }, device);
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
