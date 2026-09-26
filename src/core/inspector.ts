import type { ExecutionResult } from "./types.js";
import { executeInApp } from "./jsExecute.js";
import { resolveStacksToSource, buildDebugStackHarvestExpression } from "./componentSource.js";
import type { RawComponentStack } from "./componentSource.js";
import { RN_PRIMITIVES_SRC, GENERIC_COMPONENT_SRC } from "./injectedFilters.js";
import { SCREEN_SPACE_HELPER_JS, type ScreenSpaceMetrics } from "./screenSpace.js";
import { SHEET_HELPERS_JS } from "./injected/sheetOffset.js";
import { FIBER_ROOTS_JS } from "./injected/fiberRoots.js";

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

            ${FIBER_ROOTS_JS}
            const roots = __eb_fiberRoots(false);
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
        /**
         * Top inset used to lift raw measurements into screen space. Omit (or pass a zero
         * inset) to hit-test in raw fiber space — the pre-normalisation behaviour.
         */
        screenSpace?: ScreenSpaceMetrics;
    } = {}
): Promise<ExecutionResult> {
    const { includeProps = true, includeFrame = true, device, screenSpace } = options;
    const metrics: ScreenSpaceMetrics = screenSpace ?? { platform: "ios", topInset: 0 };

    const expression = `
        new Promise(function(resolve) {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            ${FIBER_ROOTS_JS}
            var roots = __eb_fiberRoots(false);
            if (roots.length === 0) return resolve(hook
                ? { error: 'No fiber roots found. The app may not have rendered yet.' }
                : { error: 'React DevTools hook not available. Make sure you are running a development build.' });

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
            // open modal. Real measurements: test-app 200 hosts / depth 255, gifted 201 / 252,
            // Boardwise 914 / 281. Anything that trips these limits now reports it.
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
            var settled = false;
            var timedOut = false;

            ${SCREEN_SPACE_HELPER_JS}
            ${SHEET_HELPERS_JS}
            var SCREEN_SPACE = ${JSON.stringify(metrics)};

            // Sheet boundaries — see injected/sheetOffset.ts. Without this the hit
            // test runs against frames that are short by the sheet's inset, so a
            // point on a modal resolves to the screen *underneath* it: the same
            // symptom the host cap used to produce, from a different cause.
            var sheetFibers = [];
            var sheetIdxByHost = [];
            for (var sf = 0; sf < hostFibers.length; sf++) {
                var bnd = modalBoundaryOf(hostFibers[sf]);
                var at = -1;
                if (bnd) {
                    for (var sj = 0; sj < sheetFibers.length; sj++) {
                        if (sheetFibers[sj] === bnd) { at = sj; break; }
                    }
                    if (at < 0) { sheetFibers.push(bnd); at = sheetFibers.length - 1; }
                }
                sheetIdxByHost.push(at);
            }
            var sheetMeasurements = new Array(sheetFibers.length).fill(null);

            var pending = hostFibers.length + sheetFibers.length;

            function done() {
                if (settled) return;
                settled = true;
                resolve(buildResult(hostFibers, measurements));
            }

            sheetFibers.forEach(function(fiber, i) {
                try {
                    getMeasurable(fiber).measureInWindow(function(fx, fy, fw, fh) {
                        sheetMeasurements[i] = { x: fx, y: fy, width: fw, height: fh };
                        if (--pending === 0) done();
                    });
                } catch(e) {
                    if (--pending === 0) done();
                }
            });

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

            /** The window rect, from the app's own root host — the same node the band rule below assumes. */
            function viewportForSheets(ms) {
                var r = ms[0];
                if (!r || !(r.width > 0) || !(r.height > 0)) return null;
                return { width: r.width, height: r.height + (r.y > 0 ? r.y : 0) };
            }

            function buildResult(fibers, measurements) {
                // The caller speaks canonical delivered pixels; measureInWindow speaks
                // points/dp. Hit-testing stays in point space (that is where the
                // measurements and the inset correction live) and only the emitted frames
                // are scaled back out, so the probe cannot drift from the geometry.
                var PX = scaleOf(SCREEN_SPACE);
                var inputX = ${x};
                var inputY = ${y};
                var targetX = inputX / PX;
                var targetY = inputY / PX;

            // Sheet correction first — derived from the sheet's own height, so
            // where it applies the band rule below has nothing left to guess.
            var sheetShifts = [];
            for (var ssI = 0; ssI < sheetMeasurements.length; ssI++) {
                sheetShifts.push(sheetShiftY(sheetMeasurements[ssI], viewportForSheets(measurements)));
            }
            for (var msI = 0; msI < measurements.length; msI++) {
                var siI = sheetIdxByHost[msI] == null ? -1 : sheetIdxByHost[msI];
                var dyI = siI >= 0 && sheetShifts[siI] ? sheetShifts[siI] : 0;
                if (dyI && measurements[msI]) measurements[msI].y += dyI;
            }

            // Lift measurements into screen space once, before anything reads them, so the
            // hit-test, the element frame, hitFrame and the hierarchy all share the caller's
            // coordinate space.
            //
            // Root containers are exempt. The band rule ("a y above the safe-area inset means
            // this node measured from a modal's container") holds for leaf elements — which is
            // all the screenshot formatters ever fed it — but a full-screen root legitimately
            // starts at y=0, and shifting it produced NativeStackView at (0,59) with height 912,
            // running 59pt off the bottom of a 912pt screen. A node at y=0 that is as tall as the
            // tallest thing measured is the root, not modal content.
            if (SCREEN_SPACE.topInset > 0) {
                // hostFibers[0] is the first host reached from the fiber root — the app's root
                // view — so its height is the screen height. Deriving it from the tallest
                // measurement instead does not work: scrollable content routinely exceeds the
                // screen, which lifts the threshold above every real root and exempts nothing.
                var screenH = (measurements[0] && measurements[0].height) || 0;
                // 0.9 rather than (screenH - inset): the app container sits a little inside the
                // window (measured 844 against a 912 screen) and must still count as a root.
                var rootMinH = screenH > 0 ? screenH * 0.9 : Infinity;
                for (var ms = 0; ms < measurements.length; ms++) {
                    var mm2 = measurements[ms];
                    if (!mm2) continue;
                    if (mm2.y === 0 && mm2.height >= rootMinH) continue;
                    mm2.y = toScreenSpaceY(mm2.y, SCREEN_SPACE);
                }
            }

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
                return { point: { x: inputX, y: inputY }, error: 'No component found at this point. Coordinates may be outside the app bounds or over a native-only element.' };
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
            // The component's own box: its nearest measured host descendant.
            //
            // Look the fiber up by identity OR by its alternate. React double-buffers fibers, so
            // a re-render between the collection walk and this descent leaves the subtree mixed:
            // bailed-out nodes keep the same object and hit, re-rendered ones are new objects and
            // miss. An identity-only lookup therefore skipped a 128x48 button box and reported
            // the 20x20 icon nested inside it as the button's frame.
            //
            // Not a union of the subtree: for a screen component that spans its scrollable
            // content, which reported a 5289pt-tall "frame" for a 912pt screen.
            function measurementFor(f) {
                var idx = hostIndex.get(f);
                if (idx === undefined && f.alternate) idx = hostIndex.get(f.alternate);
                return idx !== undefined ? measurements[idx] : null;
            }
            function frameOfNamed(namedFiber) {
                var found = null;
                (function down(f, d) {
                    if (found || !f || d > 40) return;
                    var m = measurementFor(f);
                    if (m && m.width > 0 && m.height > 0) { found = m; return; }
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
                point: { x: inputX, y: inputY },
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

            // Point space -> canonical delivered pixels, once, on the way out. Every frame
            // the caller sees goes through here, so frame, hitFrame and each ancestor in
            // hierarchy stay in the same space as get_screen_state and tap().
            if (PX !== 1) {
                var scaleFrame = function(f) {
                    if (!f) return;
                    f.x = Math.round(f.x * PX);
                    f.y = Math.round(f.y * PX);
                    f.width = Math.round(f.width * PX);
                    f.height = Math.round(f.height * PX);
                };
                scaleFrame(result.frame);
                scaleFrame(result.hitFrame);
                for (var hi = 0; hi < hierarchy.length; hi++) scaleFrame(hierarchy[hi].frame);
            }

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
