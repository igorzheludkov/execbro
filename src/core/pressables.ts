import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";
import { VISIBILITY_HELPERS_JS } from "./injected/visibility.js";
import { RN_PRIMITIVES_SRC } from "./injectedFilters.js";
import { SHEET_HELPERS_JS } from "./injected/sheetOffset.js";

// ============================================================================
// Pressable Elements & onPress invocation
// ============================================================================

// --- measureInWindow completion polling ---

/**
 * Both fiber passes below dispatch measureInWindow for every candidate host and
 * then read the results back in a second eval. The wait between the two used to
 * be a flat `delay(300)`; measured on device (2026-07-31) the two evals cost
 * ~50ms and ~15ms, so the sleep was 5x the real work and dominated every fiber
 * tap (3 depth attempts -> ~1.1s).
 *
 * We now poll the in-app measurement arrays instead. A poll eval is ~15ms, so a
 * screen whose callbacks land in the first frame proceeds in ~40ms instead of
 * 300ms. The deadline keeps the worst case (a host whose callback never fires,
 * leaving a permanent null) no slower than the old fixed wait.
 */
export const MEASURE_POLL_SCHEDULE_MS = [20, 40, 60, 100, 140];
export const MEASURE_POLL_DEADLINE_MS = 300;

/**
 * Poll until every slot in the named in-app measurement arrays is filled.
 * `evaluatePending` returns the number of not-yet-measured slots (or null when
 * the evaluation failed — treated as "stop waiting", same as the old code which
 * simply proceeded after its sleep). Injected for testing.
 */
export async function waitForMeasurements(args: {
    evaluatePending: () => Promise<number | null>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<{ pending: number | null; polls: number; waitedMs: number }> {
    const now = args.now ?? (() => Date.now());
    const sleep = args.sleep ?? delay;
    const start = now();
    let pending: number | null = null;
    let polls = 0;

    for (const step of MEASURE_POLL_SCHEDULE_MS) {
        await sleep(step);
        pending = await args.evaluatePending();
        polls++;
        // null => the probe itself failed; 0 => everything measured.
        if (pending === null || pending === 0) break;
        if (now() - start >= MEASURE_POLL_DEADLINE_MS) break;
    }

    return { pending, polls, waitedMs: now() - start };
}

/**
 * Build the probe expression counting unfilled slots across the given globals.
 */
export function buildPendingMeasurementExpression(globalNames: string[]): string {
    const list = globalNames.map((n) => `globalThis.${n}`).join(", ");
    return `(function() {
        var arrays = [${list}];
        var pending = 0;
        for (var a = 0; a < arrays.length; a++) {
            var m = arrays[a];
            if (!m) continue;
            for (var i = 0; i < m.length; i++) { if (!m[i]) pending++; }
        }
        return pending;
    })()`;
}

async function awaitMeasurements(
    globalNames: string[],
    toolName: string,
    device?: string
): Promise<void> {
    await waitForMeasurements({
        evaluatePending: async () => {
            const res = await executeInApp(
                buildPendingMeasurementExpression(globalNames),
                false,
                { timeoutMs: 5000, originatingToolName: toolName },
                device
            );
            if (!res.success) return null;
            const n = Number(res.result);
            return Number.isFinite(n) ? n : null;
        }
    });
}

// ============================================================================
// Press Element (invoke onPress via React Fiber Tree)
// ============================================================================

/**
 * Find a pressable element in the React fiber tree and invoke its onPress handler.
 * Matches by text content, testID, or component name.
 */
export async function pressElement(options: {
    text?: string;
    testID?: string;
    component?: string;
    index?: number;
    maxTraversalDepth?: number;
    device?: string;
    /**
     * Accept elements that only have `onLongPress`. Off by default: a short tap on
     * such an element does nothing, so resolving it would be a confident miss.
     */
    longPress?: boolean;
}): Promise<ExecutionResult> {
    const { text, testID, component, index = 0, maxTraversalDepth = 15, longPress = false } = options;

    if (!text && !testID && !component) {
        return { success: false, error: "At least one of text, testID, or component must be provided." };
    }

    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const textParam = text ? `'${esc(text)}'` : "null";
    const testIDParam = testID ? `'${esc(testID)}'` : "null";
    const componentParam = component ? `'${esc(component)}'` : "null";

    // --- Step 1: Walk fiber tree, collect pressable/input elements, dispatch measureInWindow ---
    const dispatchExpression = `
        (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found. Ensure app is running in __DEV__ mode.' };

            var roots = [];
            if (hook.getFiberRoots) {
                roots = Array.from(hook.getFiberRoots(1) || []);
            }
            if (roots.length === 0 && hook.renderers) {
                for (var entry of hook.renderers) {
                    var r = Array.from(hook.getFiberRoots ? (hook.getFiberRoots(entry[0]) || []) : []);
                    if (r.length > 0) { roots = r; break; }
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found. Is a React Native app mounted?' };

            var wantLongPress = ${longPress ? "true" : "false"};

            // One predicate, six call sites. The duplication is why long-press-only
            // elements were invisible here while inspector.ts already counted them as
            // pressable — fixing one copy would have left five.
            function isPressableProps(p) {
                if (!p) return false;
                if (typeof p.onPress === 'function') return true;
                // Switch/Checkbox: no onPress anywhere on the fiber, so these used to be
                // untargetable — the only way to flip one was to guess an x from a
                // screenshot and pair it with the row label's y, which silently flips the
                // neighbouring row when the guess is off.
                if (typeof p.onValueChange === 'function') return true;
                return wantLongPress && typeof p.onLongPress === 'function';
            }
            /**
             * A Switch is not identified by its handlers. Verified on device
             * (RN 0.83, iPhone Air): the app renders <Switch value={x} /> with no
             * onValueChange at all and drives it from a gesture-handler row, so the
             * fiber carries value and nothing else. Keying off onValueChange alone
             * would leave exactly the switch that prompted this untargetable.
             */
            function isSwitchFiber(fiber, p) {
                if (p && typeof p.onValueChange === 'function') return true;
                if (!fiber || typeof fiber.type === 'string') return false;
                return getComponentName(fiber) === 'Switch';
            }
            /** Current value of a Switch-like element; null when this is not one. */
            function switchValueOf(fiber, p) {
                if (!isSwitchFiber(fiber, p)) return null;
                return p && typeof p.value === 'boolean' ? p.value : null;
            }
            function hasLongPressProps(p) {
                return !!(p && typeof p.onLongPress === 'function');
            }

            var searchText = ${textParam};
            var searchTestID = ${testIDParam};
            var searchComponent = ${componentParam};
            var targetIndex = ${index};
            var maxTraversalUp = ${maxTraversalDepth};

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            ${VISIBILITY_HELPERS_JS}
            ${SHEET_HELPERS_JS}

            // When a fiber holds a string/number child via memoizedProps.children, return it
            // without recursing — Text > RCTText > NativeText all carry the same string,
            // and walking through every layer duplicates it (e.g. "CircularsCircularsCirculars").
            function extractText(fiber, depth) {
                if (!fiber || depth > 5000) return '';
                var props = fiber.memoizedProps;
                if (props) {
                    var ch = props.children;
                    if (typeof ch === 'string') return ch;
                    if (typeof ch === 'number') return String(ch);
                    if (Array.isArray(ch)) {
                        var allPrimitive = ch.length > 0;
                        var inline = [];
                        for (var i = 0; i < ch.length; i++) {
                            if (typeof ch[i] === 'string') inline.push(ch[i]);
                            else if (typeof ch[i] === 'number') inline.push(String(ch[i]));
                            else { allPrimitive = false; }
                        }
                        if (allPrimitive && inline.length > 0) return inline.join('');
                    }
                }
                var parts = [];
                var child = fiber.child;
                while (child) {
                    var t = extractText(child, depth + 1);
                    if (t) parts.push(t);
                    child = child.sibling;
                }
                return parts.join(' ');
            }

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

            // Shared with screenState/inputTarget — see injectedFilters.ts. This file used to
            // carry two hand-pasted copies of this pattern; divergence between copies is what
            // let inspect_at_point report a context provider as the touched element.
            var RN_PRIMITIVES = ${RN_PRIMITIVES_SRC};

            function isScreenHidden(name, props) {
                return isHiddenNavigationScene(name, props);
            }

            function findMeaningfulAncestorName(fiber) {
                var cur = fiber.return;
                var depth = 0;
                var fallbackName = null;
                while (cur && depth < 20) {
                    var aname = getComponentName(cur);
                    if (aname && typeof cur.type !== 'string') {
                        if (!fallbackName) fallbackName = aname;
                        if (!RN_PRIMITIVES.test(aname)) return aname;
                    }
                    cur = cur.return;
                    depth++;
                }
                return fallbackName;
            }

            // Walk UP collecting testID/nativeID from ancestors. Stop at screen boundaries.
            function collectAncestorTestIDs(fiber, maxUp) {
                var ids = [];
                var cur = fiber.return;
                var d = 0;
                while (cur && d < maxUp) {
                    var cname = getComponentName(cur);
                    if (cname === 'RNSScreen' || cname === 'MaybeScreen' || cname === 'SceneView') break;
                    var cp = cur.memoizedProps;
                    if (cp) {
                        if (typeof cp.testID === 'string' && cp.testID) ids.push(cp.testID);
                        if (typeof cp.nativeID === 'string' && cp.nativeID) ids.push(cp.nativeID);
                    }
                    cur = cur.return;
                    d++;
                }
                return ids;
            }

            // Find the first measurable host descendant of a fiber.
            // For inputs, prefer TextInput-specific hosts over generic RCTView.
            function findFirstHost(fiber, depth, isInput) {
                if (!fiber || depth > 20) return null;
                if (typeof fiber.type === 'string' && getMeasurable(fiber)) {
                    if (isInput) {
                        var hostType = typeof fiber.type === 'string' ? fiber.type : '';
                        if (hostType.indexOf('TextInput') !== -1 || hostType.indexOf('textinput') !== -1) {
                            return fiber;
                        }
                    }
                    return fiber;
                }
                var child = fiber.child;
                var fallback = null;
                while (child) {
                    var found = findFirstHost(child, depth + 1, isInput);
                    if (found) {
                        if (isInput) {
                            var ft = typeof found.type === 'string' ? found.type : '';
                            if (ft.indexOf('TextInput') !== -1 || ft.indexOf('textinput') !== -1) {
                                return found;
                            }
                            if (!fallback) fallback = found;
                        } else {
                            return found;
                        }
                    }
                    child = child.sibling;
                }
                return fallback;
            }

            var hostFibers = [];
            var tapMeta = [];

            // Phase 1: Walk the entire tree, collect all pressable/input elements
            function walkFiber(fiber, depth, path) {
                if (!fiber || depth > 5000) return;
                var name = getComponentName(fiber);
                var props = fiber.memoizedProps;

                if (isScreenHidden(name, props)) return;

                var isPressable = isPressableProps(props) || isSwitchFiber(fiber, props);
                var isInput = !isPressable && props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');

                if (isPressable || isInput) {
                    var text = '';
                    if (isPressable) {
                        text = extractText(fiber, 0);
                    } else {
                        var val = typeof props.value === 'string' ? props.value : '';
                        var defVal = typeof props.defaultValue === 'string' ? props.defaultValue : '';
                        var ph = typeof props.placeholder === 'string' ? props.placeholder : '';
                        text = extractText(fiber, 0) || val || defVal || ph;
                    }
                    var tid = props.testID || props.nativeID || null;
                    var meaningful = findMeaningfulAncestorName(fiber);
                    var ancestorIDs = collectAncestorTestIDs(fiber, maxTraversalUp);

                    var host = findFirstHost(fiber, 0, isInput);
                    if (host) {
                        hostFibers.push(host);
                        tapMeta.push({
                            name: name || '(anonymous)',
                            meaningfulComponentName: meaningful || null,
                            text: text.substring(0, 100),
                            testID: tid,
                            ancestorTestIDs: ancestorIDs,
                            path: path.join(' > '),
                            isInput: isInput,
                            isPressable: isPressable,
                            hasLongPress: hasLongPressProps(props),
                            switchValue: switchValueOf(fiber, props),
                            source: 'direct'
                        });
                    }
                }

                var child = fiber.child;
                while (child) {
                    var childName = getComponentName(child);
                    walkFiber(child, depth + 1, childName ? path.concat([childName]) : path);
                    child = child.sibling;
                }
            }

            for (var ri = 0; ri < roots.length; ri++) {
                walkFiber(roots[ri].current, 0, []);
            }

            // Phase 2a: testID on non-pressable wrapper — walk UP or DOWN to pressable/input.
            // Skipped if Phase 1 already matched via own testID or ancestor testID.
            if (searchTestID !== null) {
                var hasEnrichedTestIDMatch = false;
                for (var di = 0; di < tapMeta.length; di++) {
                    if (tapMeta[di].testID === searchTestID) { hasEnrichedTestIDMatch = true; break; }
                    var aids = tapMeta[di].ancestorTestIDs || [];
                    for (var ai = 0; ai < aids.length; ai++) {
                        if (aids[ai] === searchTestID) { hasEnrichedTestIDMatch = true; break; }
                    }
                    if (hasEnrichedTestIDMatch) break;
                }

                if (!hasEnrichedTestIDMatch) {
                    function findDescendantPressable(fiber, d) {
                        if (!fiber || d > 10) return null;
                        var fp = fiber.memoizedProps;
                        var dIsPressable = isPressableProps(fp) || isSwitchFiber(fiber, fp);
                        var dIsInput = !dIsPressable && fp && (typeof fp.onChangeText === 'function' || typeof fp.onFocus === 'function');
                        if (dIsPressable || dIsInput) return { fiber: fiber, isPressable: dIsPressable, isInput: dIsInput };
                        var c = fiber.child;
                        while (c) {
                            var r = findDescendantPressable(c, d + 1);
                            if (r) return r;
                            c = c.sibling;
                        }
                        return null;
                    }

                    function findByTestID2a(fiber, path) {
                        if (!fiber) return;
                        var name = getComponentName(fiber);
                        var props = fiber.memoizedProps;
                        if (isScreenHidden(name, props)) return;

                        var tid = props && (props.testID || props.nativeID || null);
                        if (tid === searchTestID) {
                            var nIsPressable = isPressableProps(props) || isSwitchFiber(fiber, props);
                            var nIsInput = !nIsPressable && props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');

                            if (nIsPressable || nIsInput) {
                                var text = nIsPressable ? extractText(fiber, 0) : (extractText(fiber, 0) || (typeof props.value === 'string' ? props.value : '') || (typeof props.defaultValue === 'string' ? props.defaultValue : '') || (typeof props.placeholder === 'string' ? props.placeholder : ''));
                                var host = findFirstHost(fiber, 0, nIsInput);
                                if (host) {
                                    hostFibers.push(host);
                                    tapMeta.push({
                                        name: name || '(anonymous)',
                                        meaningfulComponentName: findMeaningfulAncestorName(fiber) || null,
                                        text: text.substring(0, 100),
                                        testID: searchTestID,
                                        ancestorTestIDs: [],
                                        path: path.join(' > '),
                                        isInput: nIsInput,
                                        isPressable: nIsPressable,
                                        hasLongPress: hasLongPressProps(props),
                                        switchValue: switchValueOf(fiber, props),
                                        source: 'testID-direct'
                                    });
                                }
                            } else {
                                var foundAncestor = false;
                                var parent = fiber.return;
                                var d = 0;
                                while (parent && d < maxTraversalUp) {
                                    var pp = parent.memoizedProps;
                                    var pIsPressable = isPressableProps(pp) || isSwitchFiber(parent, pp);
                                    var pIsInput = !pIsPressable && pp && (typeof pp.onChangeText === 'function' || typeof pp.onFocus === 'function');
                                    if (pIsPressable || pIsInput) {
                                        var pText = pIsPressable ? extractText(parent, 0) : (extractText(parent, 0) || (typeof pp.value === 'string' ? pp.value : '') || (typeof pp.defaultValue === 'string' ? pp.defaultValue : '') || (typeof pp.placeholder === 'string' ? pp.placeholder : ''));
                                        var host = findFirstHost(parent, 0, pIsInput);
                                        if (host) {
                                            hostFibers.push(host);
                                            tapMeta.push({
                                                name: name || '(anonymous)',
                                                meaningfulComponentName: findMeaningfulAncestorName(parent) || null,
                                                text: pText.substring(0, 100),
                                                testID: pp.testID || pp.nativeID || searchTestID,
                                                ancestorTestIDs: [],
                                                path: path.join(' > '),
                                                isInput: pIsInput,
                                                isPressable: pIsPressable,
                                                hasLongPress: hasLongPressProps(pp),
                                                switchValue: switchValueOf(parent, pp),
                                                source: 'testID-ancestor'
                                            });
                                            foundAncestor = true;
                                        }
                                        break;
                                    }
                                    parent = parent.return;
                                    d++;
                                }

                                if (!foundAncestor) {
                                    var desc = findDescendantPressable(fiber, 0);
                                    if (desc) {
                                        var dp = desc.fiber.memoizedProps;
                                        var dText = desc.isPressable ? extractText(desc.fiber, 0) : (extractText(desc.fiber, 0) || (typeof dp.value === 'string' ? dp.value : '') || (typeof dp.defaultValue === 'string' ? dp.defaultValue : '') || (typeof dp.placeholder === 'string' ? dp.placeholder : ''));
                                        var dhost = findFirstHost(desc.fiber, 0, desc.isInput);
                                        if (dhost) {
                                            hostFibers.push(dhost);
                                            tapMeta.push({
                                                name: getComponentName(desc.fiber) || '(anonymous)',
                                                meaningfulComponentName: findMeaningfulAncestorName(desc.fiber) || null,
                                                text: dText.substring(0, 100),
                                                testID: dp.testID || dp.nativeID || searchTestID,
                                                ancestorTestIDs: [searchTestID],
                                                path: path.join(' > '),
                                                isInput: desc.isInput,
                                                isPressable: desc.isPressable,
                                                hasLongPress: hasLongPressProps(dp),
                                                switchValue: switchValueOf(desc.fiber, dp),
                                                source: 'testID-descendant'
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        var child = fiber.child;
                        while (child) {
                            var childName = getComponentName(child);
                            findByTestID2a(child, childName ? path.concat([childName]) : path);
                            child = child.sibling;
                        }
                    }
                    for (var ri2a = 0; ri2a < roots.length; ri2a++) {
                        findByTestID2a(roots[ri2a].current, []);
                    }
                }
            }

            // Phase 2b: component name on non-pressable node — walk UP or DOWN to pressable parent.
            // Skipped if Phase 1 already matched via own name or meaningfulComponentName.
            if (searchComponent !== null) {
                var scLower = searchComponent.toLowerCase();
                var hasEnrichedComponentMatch = false;
                for (var ci = 0; ci < tapMeta.length; ci++) {
                    var cn = (tapMeta[ci].name || '').toLowerCase();
                    var cm = (tapMeta[ci].meaningfulComponentName || '').toLowerCase();
                    if (cn.indexOf(scLower) !== -1 || cm.indexOf(scLower) !== -1) {
                        hasEnrichedComponentMatch = true; break;
                    }
                }

                if (!hasEnrichedComponentMatch) {
                    function findDescendantPressableOnly(fiber, d) {
                        if (!fiber || d > 10) return null;
                        var fp = fiber.memoizedProps;
                        if (isPressableProps(fp) || isSwitchFiber(fiber, fp)) return fiber;
                        var c = fiber.child;
                        while (c) {
                            var r = findDescendantPressableOnly(c, d + 1);
                            if (r) return r;
                            c = c.sibling;
                        }
                        return null;
                    }

                    function findByName2b(fiber, path) {
                        if (!fiber) return;
                        var name = getComponentName(fiber);
                        var props = fiber.memoizedProps;
                        if (isScreenHidden(name, props)) return;

                        if (name && name.toLowerCase().indexOf(scLower) !== -1) {
                            var foundAncestor = false;
                            var parent = fiber.return;
                            var d = 0;
                            while (parent && d < maxTraversalUp) {
                                var pp = parent.memoizedProps;
                                if (isPressableProps(pp) || isSwitchFiber(parent, pp)) {
                                    var text = extractText(parent, 0);
                                    var host = findFirstHost(parent, 0, false);
                                    if (host) {
                                        hostFibers.push(host);
                                        tapMeta.push({
                                            name: name,
                                            meaningfulComponentName: findMeaningfulAncestorName(parent) || null,
                                            text: text.substring(0, 100),
                                            testID: pp.testID || pp.nativeID || null,
                                            ancestorTestIDs: [],
                                            path: path.join(' > '),
                                            isInput: false,
                                            isPressable: true,
                                            hasLongPress: hasLongPressProps(pp),
                                            switchValue: switchValueOf(parent, pp),
                                            source: 'component-ancestor'
                                        });
                                        foundAncestor = true;
                                    }
                                    break;
                                }
                                parent = parent.return;
                                d++;
                            }

                            if (!foundAncestor) {
                                var descFiber = findDescendantPressableOnly(fiber, 0);
                                if (descFiber) {
                                    var dp = descFiber.memoizedProps;
                                    var dText = extractText(descFiber, 0);
                                    var dhost = findFirstHost(descFiber, 0, false);
                                    if (dhost) {
                                        hostFibers.push(dhost);
                                        tapMeta.push({
                                            name: getComponentName(descFiber) || '(anonymous)',
                                            meaningfulComponentName: name,
                                            text: dText.substring(0, 100),
                                            testID: dp.testID || dp.nativeID || null,
                                            ancestorTestIDs: [],
                                            path: path.join(' > '),
                                            isInput: false,
                                            isPressable: true,
                                            hasLongPress: hasLongPressProps(dp),
                                            switchValue: switchValueOf(descFiber, dp),
                                            source: 'component-descendant'
                                        });
                                    }
                                }
                            }
                        }
                        var child = fiber.child;
                        while (child) {
                            var childName = getComponentName(child);
                            findByName2b(child, childName ? path.concat([childName]) : path);
                            child = child.sibling;
                        }
                    }
                    for (var ri2b = 0; ri2b < roots.length; ri2b++) {
                        findByName2b(roots[ri2b].current, []);
                    }
                }
            }

            if (hostFibers.length === 0) {
                var criteria = [];
                if (searchText !== null) criteria.push('text="' + searchText + '"');
                if (searchTestID !== null) criteria.push('testID="' + searchTestID + '"');
                if (searchComponent !== null) criteria.push('component="' + searchComponent + '"');
                return { error: 'No pressable or focusable elements found. Searched for: ' + criteria.join(', ') };
            }

            // Sheet boundaries and the true viewport.
            //
            // A modally-presented screen is laid out by UIKit at an offset RN's
            // measurements do not include (injected/sheetOffset.ts). Without this,
            // fiber coordinates inside a sheet are short by that inset — and the
            // viewport heuristic below, which picks whatever measured first at
            // x=0, sized the sheet rather than the window and reported every
            // element on it as "below-viewport". Both come from the same gap.
            var sheetFibers = [];
            var sheetIdxByHost = [];
            for (var sfi2 = 0; sfi2 < hostFibers.length; sfi2++) {
                var bnd = modalBoundaryOf(hostFibers[sfi2]);
                var at = -1;
                if (bnd) {
                    for (var sfj = 0; sfj < sheetFibers.length; sfj++) {
                        if (sheetFibers[sfj] === bnd) { at = sfj; break; }
                    }
                    if (at < 0) { sheetFibers.push(bnd); at = sheetFibers.length - 1; }
                }
                sheetIdxByHost.push(at);
            }

            // Store host fibers and metadata globally for step 2, dispatch measureInWindow
            globalThis.__tapHostFibers = hostFibers;
            globalThis.__tapMeta = tapMeta;
            globalThis.__tapMeasurements = new Array(hostFibers.length).fill(null);
            globalThis.__tapSheetIdx = sheetIdxByHost;
            globalThis.__tapSheetMeasurements = new Array(sheetFibers.length).fill(null);
            globalThis.__tapViewport = null;
            for (var shi2 = 0; shi2 < sheetFibers.length; shi2++) {
                try {
                    (function(idx) {
                        getMeasurable(sheetFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                            globalThis.__tapSheetMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                        });
                    })(shi2);
                } catch(e) {}
            }
            try {
                var viewportHost = null;
                (function findRootHost(f, d) {
                    if (viewportHost || !f || d > 40) return;
                    if (typeof f.type === 'string' && getMeasurable(f)) { viewportHost = f; return; }
                    var c = f.child;
                    while (c && !viewportHost) { findRootHost(c, d + 1); c = c.sibling; }
                })(roots[0].current, 0);
                if (viewportHost) {
                    getMeasurable(viewportHost).measureInWindow(function(fx, fy, fw, fh) {
                        globalThis.__tapViewport = { x: fx, y: fy, width: fw, height: fh };
                    });
                }
            } catch(e) {}

            for (var mi = 0; mi < hostFibers.length; mi++) {
                try {
                    (function(idx) {
                        getMeasurable(hostFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                            globalThis.__tapMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                        });
                    })(mi);
                } catch(e) {}
            }

            return { count: hostFibers.length };
        })()
    `;

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000, originatingToolName: "tap" }, options.device);
    if (!dispatchResult.success) return dispatchResult;

    try {
        const parsed = JSON.parse(dispatchResult.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
    } catch {
        /* ignore */
    }

    // Wait for measureInWindow callbacks (adaptive; see waitForMeasurements)
    await awaitMeasurements(["__tapMeasurements"], "tap", options.device);

    // --- Step 2: Read measurements, filter visible, match by query ---
    const resolveExpression = `
        (function() {
            ${SHEET_HELPERS_JS}
            var hostFibers = globalThis.__tapHostFibers;
            var meta = globalThis.__tapMeta;
            var measurements = globalThis.__tapMeasurements;
            var sheetIdxByHost = globalThis.__tapSheetIdx || [];
            var sheetMeasurements = globalThis.__tapSheetMeasurements || [];
            var viewportM = globalThis.__tapViewport;
            globalThis.__tapHostFibers = null;
            globalThis.__tapMeta = null;
            globalThis.__tapMeasurements = null;
            globalThis.__tapSheetIdx = null;
            globalThis.__tapSheetMeasurements = null;
            globalThis.__tapViewport = null;

            if (!hostFibers || !measurements || !meta) {
                return { error: 'No measurement data. Dispatch step may have failed.' };
            }

            var searchText = ${textParam};
            var searchTestID = ${testIDParam};
            var searchComponent = ${componentParam};
            var targetIndex = ${index};

            // Determine viewport bounds. The app's own root host is the honest
            // answer; the scan below is the fallback for when it did not measure.
            var viewportW = 9999, viewportH = 9999;
            if (viewportM && viewportM.width > 0 && viewportM.height > 0) {
                viewportW = viewportM.width;
                viewportH = viewportM.height + (viewportM.y > 0 ? viewportM.y : 0);
            }
            for (var v = 0; viewportW === 9999 && v < measurements.length; v++) {
                if (measurements[v] && measurements[v].x === 0 && measurements[v].y <= 0 &&
                    measurements[v].width > 0 && measurements[v].height > 0) {
                    viewportW = measurements[v].width;
                    viewportH = measurements[v].height + measurements[v].y;
                    break;
                }
            }

            // Filter visible and match. Track query-matching elements that fail
            // the visibility filter so we can distinguish "exists but off-screen /
            // not laid out" from "doesn't exist in the fiber tree at all".
            var matches = [];
            var invisibleMatches = [];
            // Correct sheet-relative measurements before anything reads them: the
            // visibility test and the tap target must share one space.
            var sheetShifts = [];
            for (var ssi = 0; ssi < sheetMeasurements.length; ssi++) {
                sheetShifts.push(sheetShiftY(sheetMeasurements[ssi], { width: viewportW, height: viewportH }));
            }

            for (var i = 0; i < measurements.length; i++) {
                var si = sheetIdxByHost[i] == null ? -1 : sheetIdxByHost[i];
                var m = shiftRect(measurements[i], si >= 0 && sheetShifts[si] ? sheetShifts[si] : 0);
                if (!m) continue;

                var info = meta[i];

                // Match by query — OR across own and enriched identifiers
                var matched = true;
                if (searchText !== null) {
                    matched = matched && info.text.toLowerCase().indexOf(searchText.toLowerCase()) !== -1;
                }
                if (searchTestID !== null) {
                    var ownTidMatch = info.testID === searchTestID;
                    var aTids = info.ancestorTestIDs || [];
                    var ancestorTidMatch = false;
                    for (var ti = 0; ti < aTids.length; ti++) {
                        if (aTids[ti] === searchTestID) { ancestorTidMatch = true; break; }
                    }
                    matched = matched && (ownTidMatch || ancestorTidMatch);
                }
                if (searchComponent !== null) {
                    var scq = searchComponent.toLowerCase();
                    var ownNameMatch = (info.name || '').toLowerCase().indexOf(scq) !== -1;
                    var meaningfulMatch = (info.meaningfulComponentName || '').toLowerCase().indexOf(scq) !== -1;
                    matched = matched && (ownNameMatch || meaningfulMatch);
                }

                if (!matched) continue;

                // Visibility filter: positive dimensions, within viewport
                var visible = m.width > 0 && m.height > 0 &&
                    (m.x + m.width >= 0) && (m.y + m.height >= 0) &&
                    m.x <= viewportW && m.y <= viewportH;

                if (visible) {
                    matches.push({
                        name: info.name,
                        text: info.text,
                        testID: info.testID,
                        path: info.path,
                        isInput: info.isInput,
                        hasLongPress: info.hasLongPress,
                        switchValue: info.switchValue,
                        x: Math.round(m.x + m.width / 2),
                        y: Math.round(m.y + m.height / 2)
                    });
                } else {
                    var reason;
                    if (m.width <= 0 || m.height <= 0) reason = 'zero-size';
                    else if (m.y >= viewportH) reason = 'below-viewport';
                    else if (m.y + m.height <= 0) reason = 'above-viewport';
                    else if (m.x >= viewportW) reason = 'right-of-viewport';
                    else if (m.x + m.width <= 0) reason = 'left-of-viewport';
                    else reason = 'off-screen';
                    invisibleMatches.push({
                        name: info.name,
                        text: info.text,
                        testID: info.testID,
                        reason: reason,
                        x: Math.round(m.x),
                        y: Math.round(m.y),
                        width: Math.round(m.width),
                        height: Math.round(m.height)
                    });
                }
            }

            if (matches.length === 0) {
                var criteria = [];
                if (searchText !== null) criteria.push('text="' + searchText + '"');
                if (searchTestID !== null) criteria.push('testID="' + searchTestID + '"');
                if (searchComponent !== null) criteria.push('component="' + searchComponent + '"');
                if (invisibleMatches.length > 0) {
                    // Element exists in the fiber tree but isn't visible — scroll,
                    // dismiss an overlay, or wait for layout before retrying.
                    return {
                        error: 'Found ' + invisibleMatches.length + ' fiber match(es) for ' + criteria.join(', ') + ' but none are visible (reasons: ' + invisibleMatches.slice(0, 3).map(function(x) { return x.reason; }).join(', ') + '). The element exists in the React tree but is off-screen or has zero dimensions.',
                        invisibleMatches: invisibleMatches.slice(0, 10),
                        existsInTree: true
                    };
                }
                return {
                    error: 'No pressable or focusable elements found matching: ' + criteria.join(', ') + '. The element is not present in the React tree on the current screen.',
                    existsInTree: false
                };
            }

            if (targetIndex >= matches.length) {
                return {
                    error: 'Found ' + matches.length + ' visible match(es) but index ' + targetIndex + ' requested (0-based). Use index 0-' + (matches.length - 1) + '.',
                    matches: matches.map(function(m, i) {
                        return { index: i, component: m.name, text: m.text, testID: m.testID };
                    })
                };
            }

            var target = matches[targetIndex];
            var result = {
                needsNativeTap: true,
                nativeTapTarget: { x: target.x, y: target.y, unit: 'points' },
                pressed: target.name,
                matchIndex: targetIndex,
                totalMatches: matches.length,
                text: target.text,
                testID: target.testID,
                path: target.path,
                isInput: target.isInput,
                // Only the fiber strategy can answer this; accessibility, OCR and
                // coordinate taps have no view of the handlers.
                hasLongPress: !!target.hasLongPress,
                // null unless the resolved element is Switch-like — lets tap report
                // the value it actually changed instead of a pixel diff that reads
                // identically for a correct and an incorrect toggle.
                switchValue: target.switchValue === undefined ? null : target.switchValue
            };
            if (matches.length > 1) {
                result.allMatches = matches.map(function(m, i) {
                    return { index: i, component: m.name, text: m.text, testID: m.testID, x: m.x, y: m.y };
                });
            }
            return result;
        })()
    `;

    return executeInApp(resolveExpression, false, { timeoutMs: 10000, originatingToolName: "tap" }, options.device);
}
