import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";
import { iconLabel } from "./iconSemantics.js";
import { getConnectedAppByDevice, getFirstConnectedApp, getConnectedAppBySimulatorUdid, getConnectedAppByAndroidDeviceId } from "./connection.js";

// ============================================================================
// Pressable Elements & onPress invocation
// ============================================================================

// --- get_pressable_elements ---

interface PressableElement {
    component: string;
    path: string;
    center: { x: number; y: number };
    frame: { x: number; y: number; width: number; height: number };
    text: string;
    testID: string | null;
    accessibilityLabel: string | null;
    hasLabel: boolean;
    isInput: boolean;
    isWrapper?: boolean;
    intent?: string;
    nearbyText?: string;
    /** Meaningful icon child component name (e.g. SvgChevronBack) for icon-only pressables. */
    icon?: string | null;
}

/**
 * E1 / Step 5 (2026-05-15 plan): build a pressables list from the platform
 * accessibility tree when fiber isn't reachable. Used when metro is offline
 * (connectedApps.size === 0) so the screenshot tools can still hand the agent
 * labelled coordinates instead of forcing it to guess pixels — the dominant
 * cause of unmeaningful coordinate-strategy taps in the 7-day failure data.
 */
async function getAccessibilityPressables(
    platform: "ios" | "android",
    udid?: string
): Promise<PressableElement[]> {
    try {
        if (platform === "ios") {
            const { iosGetUITree } = await import("./ios.js");
            const tree = await iosGetUITree(udid);
            if (!tree.success || !tree.elements) return [];
            const interactiveTraits = new Set(["button", "link", "searchfield", "tab", "image"]);
            return tree.elements
                .filter(el => {
                    // iOS: rely on a11y traits + element type. Buttons, links,
                    // tabs, and any element with a non-empty label/identifier
                    // that isn't a static text container.
                    const traitsLower = (el.traits || []).map(t => t.toLowerCase());
                    if (traitsLower.some(t => interactiveTraits.has(t))) return true;
                    const type = (el.type || "").toLowerCase();
                    if (type.includes("button") || type.includes("textfield") || type.includes("searchfield")) return true;
                    return false;
                })
                .map(el => {
                    const type = (el.type || "").toLowerCase();
                    return {
                        component: el.type || "Element",
                        path: "",
                        center: el.center,
                        frame: el.frame,
                        text: el.label || "",
                        testID: el.identifier || null,
                        accessibilityLabel: el.label || null,
                        hasLabel: !!el.label,
                        isInput: type.includes("textfield") || type.includes("searchfield")
                    };
                });
        } else {
            const { androidGetUITree } = await import("./android.js");
            const tree = await androidGetUITree();
            if (!tree.success || !tree.elements) return [];
            return tree.elements
                .filter(el => el.clickable || el.focused || (el.className && el.className.includes("EditText")))
                .map(el => ({
                    component: (el.className || "View").split(".").pop() || "View",
                    path: "",
                    center: el.center,
                    frame: { x: el.bounds.left, y: el.bounds.top, width: el.bounds.width, height: el.bounds.height },
                    text: el.text || "",
                    testID: el.resourceId || null,
                    accessibilityLabel: el.contentDesc || null,
                    hasLabel: !!(el.text || el.contentDesc),
                    isInput: !!(el.className && el.className.includes("EditText"))
                }));
        }
    } catch {
        return [];
    }
}

export async function getPressableElements(
    options: { device?: string; platform?: "ios" | "android"; udid?: string } = {}
): Promise<ExecutionResult & { parsedElements?: PressableElement[] }> {
    const { device, platform, udid } = options;

    // Resolve which connected RN app corresponds to the requested device/udid.
    // The E1 fallback below must fire when no app matches THIS device, even if
    // unrelated apps remain connected to Metro. Without this filter the fiber
    // path would silently fall back to the first-connected app and return data
    // for the wrong device (Bug 1, 2026-05-16).
    let targetApp: ReturnType<typeof getFirstConnectedApp> = null;
    if (udid && platform === "ios") {
        targetApp = getConnectedAppBySimulatorUdid(udid);
        // scan_metro links simulatorUdid asynchronously after the CDP connect; in
        // that window the udid lookup misses even though the right app is already
        // connected. Fall back to the device-name match so callers (ios_screenshot)
        // don't silently degrade to the accessibility-tree pressables list.
        if (!targetApp && device) {
            const matched = getConnectedAppByDevice(device);
            if (matched && matched.platform === "ios") targetApp = matched;
        }
    } else if (device) {
        const matched = getConnectedAppByDevice(device);
        if (matched && (!platform || matched.platform === platform)) targetApp = matched;
    } else if (platform === "android") {
        targetApp = getConnectedAppByAndroidDeviceId(undefined);
    } else if (platform === "ios") {
        const first = getFirstConnectedApp();
        targetApp = first && first.platform === "ios" ? first : null;
    } else {
        targetApp = getFirstConnectedApp();
    }

    // When the caller didn't pin a platform, adopt the resolved app's platform so
    // downstream branches (Android coordinate reconciliation below) run uniformly
    // regardless of entry point. The standalone get_pressable_elements MCP tool
    // omits `platform`; without this derivation it would skip reconciliation and
    // return raw fiber DP that downstream consumers misinterpret as device pixels.
    const effectivePlatform: "ios" | "android" | undefined = platform ?? targetApp?.platform;

    // E1 fallback: no app resolved for THIS device → use platform accessibility tree.
    // Only kicks in when caller passed `platform` so we don't break older
    // metro-required call paths that didn't opt into the fallback.
    if (!targetApp && platform) {
        const elements = await getAccessibilityPressables(platform, udid);
        return {
            success: true,
            result: elements.length > 0
                ? `Pressable elements (from accessibility tree, ${elements.length} found):\n` +
                  elements.map((el, i) => {
                      const label = el.accessibilityLabel || el.text || el.testID || el.component;
                      const idStr = el.testID ? ` testID="${el.testID}"` : "";
                      const inputStr = el.isInput ? " [input]" : "";
                      return `${i + 1}. ${el.component} "${label}"${idStr}${inputStr} — center:(${el.center.x},${el.center.y}) frame:(${el.frame.x},${el.frame.y} ${el.frame.width}x${el.frame.height})`;
                  }).join("\n")
                : "No interactive elements found via accessibility.",
            parsedElements: elements
        };
    }

    // --- Step 1: walk fiber tree, find pressable/input elements, dispatch measureInWindow ---
    const dispatchExpression = `
        (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found.' };

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
            if (roots.length === 0) return { error: 'No fiber roots found.' };

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

            function collectText(fiber, d, isRoot) {
                if (!fiber || d > 30) return '';
                var props = fiber.memoizedProps;
                // Stop descent at nested pressable/input boundaries — their text belongs to them, not to the outer wrapper.
                if (!isRoot && props && (typeof props.onPress === 'function' ||
                                          typeof props.onChangeText === 'function' ||
                                          typeof props.onFocus === 'function')) {
                    return '';
                }
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
                    var t = collectText(child, d + 1, false);
                    if (t) parts.push(t);
                    child = child.sibling;
                }
                return parts.join(' ').replace(/\\s+/g, ' ').trim();
            }

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            var RN_PRIMITIVES = /^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|ScrollViewContext(Base)?|VirtualizedListContext(Resetter)?|TextInputContext|KeyboardAvoidingViewContext|RCT.*|RNS.*|RNC.*|ViewManagerAdapter_.*|VirtualizedList.*|CellRenderer.*|FrameSizeProvider.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|SafeAreaProvider.*|SafeAreaFrameContext|SafeAreaInsetsContext|ExpoRoot|ExpoRootComponent|GestureHandler.*|NativeViewGestureHandler|GestureDetector|PanGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|KeyboardProvider|PortalProviderComponent|BottomSheetModalProviderWrapper|ThemeContext|ThemeProvider|TextAncestorContext|PressabilityDebugView|TouchableHighlightImpl|StatusBarOverlay|BottomSheetHostingContainerComponent|BottomSheetGestureHandlersProvider|BottomSheetBackdropContainerComponent|BottomSheetContainerComponent|BottomSheetDraggableViewComponent|BottomSheetHandleContainerComponent|BottomSheetBackgroundContainerComponent|DebuggingOverlay|InspectorDeferred|Inspector|InspectorOverlay|InspectorPanel|StyleInspector|BoxInspector|BoxContainer|ElementBox|BorderBox|InspectorPanelButton)$/;

            var hostFibers = [];
            var fiberMeta = [];
            var textFibers = [];
            var textContents = [];

            function findMeaningfulAncestorName(fiber) {
                var cur = fiber.return;
                var depth = 0;
                var fallbackName = null;
                while (cur && depth < 20) {
                    var name = getComponentName(cur);
                    if (name && typeof cur.type !== 'string') {
                        if (!fallbackName) fallbackName = name;
                        if (!RN_PRIMITIVES.test(name)) return name;
                    }
                    cur = cur.return;
                    depth++;
                }
                return fallbackName;
            }

            // Layout-only and touch-wrapper components that should be skipped when scanning
            // children for a meaningful icon/content component name.
            var SKIP_IN_CHILD_SCAN = /^(View|Text|Image|ImageBackground|ScrollView|FlatList|SectionList|KeyboardAvoidingView|SafeAreaView|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TouchableNativeFeedback|Pressable|TextInput|ActivityIndicator|Switch|Modal|StatusBar|VirtualizedList|RefreshControl|Animated\\(.*|withAnimated.*|AnimatedComponent.*)$/;

            // Scan children of a pressable for a meaningful component name (e.g. SvgChevronBack inside a View).
            // Skips generic layout/touch wrappers to find the actual icon or content component.
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

            var GENERIC_COMPONENT = /^(View|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Pressable|TouchableNativeFeedback|Text|RCTView|RCTText|Unknown)$/;

            // The components that render PressabilityDebugView in DEV builds. Used to walk
            // up from a PDV's host view to the touchable that owns it — the composite chain
            // in between is generic wrappers (View ForwardRef, Animated(View)) whose props
            // carry no onPress, so they are useless as a collectText / identifier root.
            var PDV_OWNER_COMPONENT = /^(Pressable|Touchable(Opacity|Highlight|WithoutFeedback|NativeFeedback|Bounce))$/;

            function buildPath(fiber) {
                var parts = [];
                var cur = fiber;
                var depth = 0;
                while (cur && depth < 30) {
                    var name = getComponentName(cur);
                    if (name && typeof cur.type !== 'string' && !RN_PRIMITIVES.test(name)) {
                        parts.unshift(name);
                    }
                    cur = cur.return;
                    depth++;
                }
                // Keep last 3 segments
                if (parts.length > 3) {
                    parts = parts.slice(-3);
                    return '... > ' + parts.join(' > ');
                }
                return parts.join(' > ');
            }

            function walkPressables(fiber, depth) {
                if (!fiber || depth > 5000) return;
                var name = getComponentName(fiber);
                var props = fiber.memoizedProps;

                // Skip inactive/unfocused screens
                if (name === 'MaybeScreen' && props && props.active === 0) return;
                if (name === 'SceneView' && props && props.focused === false) return;
                if (name === 'RNSScreen' && props && props['aria-hidden'] === true) return;

                var isPressable = props && typeof props.onPress === 'function';
                var isInput = !isPressable && props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');

                if (isPressable || isInput) {
                    var hostsForThis = [];
                    findHostsInSubtree(fiber, 0, hostsForThis, 16);
                    if (hostsForThis.length > 0) {
                        var text = collectText(fiber, 0, true);
                        var componentName = findMeaningfulAncestorName(fiber) || name || 'Unknown';
                        // Scan children for a meaningful name like SvgChevronBack: it replaces a
                        // generic name (View, TouchableOpacity) and is also kept as the icon hint
                        // for text-less buttons even when the ancestor name (FloatingHeader) wins.
                        var childName = (!text || GENERIC_COMPONENT.test(componentName)) ? findMeaningfulChildName(fiber) : null;
                        if (childName && GENERIC_COMPONENT.test(componentName)) componentName = childName;
                        var path = buildPath(fiber);
                        var testID = (props && (props.testID || props.nativeID)) || null;
                        var accessibilityLabel = (props && props.accessibilityLabel) || null;

                        var hostIndices = [];
                        for (var hi = 0; hi < hostsForThis.length; hi++) {
                            hostIndices.push(hostFibers.length);
                            hostFibers.push(hostsForThis[hi]);
                        }
                        fiberMeta.push({
                            component: componentName,
                            path: path,
                            text: text ? text.slice(0, 100) : '',
                            testID: testID,
                            accessibilityLabel: accessibilityLabel,
                            isInput: !!isInput,
                            icon: childName || null,
                            hostIndices: hostIndices
                        });
                    }
                }

                var child = fiber.child;
                while (child) {
                    walkPressables(child, depth + 1);
                    child = child.sibling;
                }
            }

            // PRIMARY detection: PressabilityDebugView-based walk — mirrors RN Inspector "Touchables" exactly.
            // In DEV mode, every Pressable / TouchableOpacity / TouchableHighlight /
            // TouchableWithoutFeedback / TouchableNativeFeedback renders a PressabilityDebugView
            // as a child.  Its immediate parent (fiber.return) is the HOST view that carries
            // the event handlers — we measure that.
            // FALLBACK: plain onPress detection for production builds (PDV not rendered).

            var anyPDV = false;
            (function quickCheckPDV(f, d) {
                if (!f || d > 200 || anyPDV) return;
                var n = getComponentName(f);
                if (n === 'PressabilityDebugView') { anyPDV = true; return; }
                quickCheckPDV(f.child, d + 1);
                if (!anyPDV) quickCheckPDV(f.sibling, d);
            })(roots[0].current, 0);

            // Walk for TextInput elements (not covered by PressabilityDebugView in either mode).
            function walkInputs(fiber, depth) {
                if (!fiber || depth > 5000) return;
                var name = getComponentName(fiber);
                var props = fiber.memoizedProps;
                if (name === 'MaybeScreen' && props && props.active === 0) return;
                if (name === 'SceneView' && props && props.focused === false) return;
                if (name === 'RNSScreen' && props && props['aria-hidden'] === true) return;
                var isInput = props && !props.onPress &&
                    (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');
                if (isInput) {
                    var hostsForThis = [];
                    findHostsInSubtree(fiber, 0, hostsForThis, 16);
                    if (hostsForThis.length > 0) {
                        var text = collectText(fiber, 0, true);
                        var componentName = findMeaningfulAncestorName(fiber) || name || 'Unknown';
                        if (GENERIC_COMPONENT.test(componentName)) {
                            var childName = findMeaningfulChildName(fiber);
                            if (childName) componentName = childName;
                        }
                        var props2 = fiber.memoizedProps || {};
                        var testID = (props2.testID || props2.nativeID) || null;
                        var accessibilityLabel = props2.accessibilityLabel || null;
                        var hostIndices = [];
                        for (var hi3 = 0; hi3 < hostsForThis.length; hi3++) {
                            hostIndices.push(hostFibers.length);
                            hostFibers.push(hostsForThis[hi3]);
                        }
                        fiberMeta.push({
                            component: componentName,
                            path: buildPath(fiber),
                            text: text ? text.slice(0, 100) : '',
                            testID: testID,
                            accessibilityLabel: accessibilityLabel,
                            isInput: true,
                            hostIndices: hostIndices
                        });
                    }
                }
                var child = fiber.child;
                while (child) { walkInputs(child, depth + 1); child = child.sibling; }
            }

            function walkPressabilityDebugViews(fiber, depth, hidden) {
                if (!fiber || depth > 5000) return;
                var name = getComponentName(fiber);
                var props = fiber.memoizedProps;
                var nextHidden = hidden;
                if (name === 'MaybeScreen' && props && props.active === 0) nextHidden = true;
                if (name === 'SceneView' && props && props.focused === false) nextHidden = true;
                if (name === 'RNSScreen' && props && props['aria-hidden'] === true) nextHidden = true;

                if (!nextHidden && name === 'PressabilityDebugView') {
                    // fiber.return = the HOST view that wraps the pressable's children
                    var hostFiber = fiber.return;
                    if (hostFiber && getMeasurable(hostFiber)) {
                        // Walk up from the host fiber to the touchable component that owns this
                        // PDV. Match by name (PDV_OWNER_COMPONENT) — stopping at the first
                        // composite ancestor is wrong because that's a generic wrapper
                        // (ForwardRef displayName 'View', then Animated(View) for Touchables).
                        var pressableFiber = hostFiber;
                        var firstComposite = null;
                        var cur = hostFiber.return;
                        var upDepth = 0;
                        while (cur && upDepth < 10) {
                            if (typeof cur.type !== 'string' && cur.type !== null) {
                                if (!firstComposite) firstComposite = cur;
                                var curName = getComponentName(cur);
                                if (curName && PDV_OWNER_COMPONENT.test(curName)) {
                                    pressableFiber = cur;
                                    break;
                                }
                            }
                            cur = cur.return;
                            upDepth++;
                        }
                        if (pressableFiber === hostFiber && firstComposite) pressableFiber = firstComposite;

                        var pressableProps = pressableFiber.memoizedProps || {};
                        var text = collectText(pressableFiber, 0, true);
                        // Prefer the nearest semantic ancestor (FilterRow, RoleButton, ...) over
                        // generic Touchable/Pressable/View wrappers. The climb is capped at a few
                        // composite levels so a bare Pressable isn't named after its screen container.
                        var componentName = null;
                        var an = pressableFiber.return;
                        var anComposites = 0;
                        var anDepth = 0;
                        while (an && anDepth < 12 && anComposites < 4 && !componentName) {
                            if (typeof an.type !== 'string') {
                                var anName = getComponentName(an);
                                if (anName) {
                                    anComposites++;
                                    if (!RN_PRIMITIVES.test(anName) && !GENERIC_COMPONENT.test(anName)) {
                                        componentName = anName;
                                    }
                                }
                            }
                            an = an.return;
                            anDepth++;
                        }
                        if (!componentName) {
                            componentName = findMeaningfulAncestorName(pressableFiber) || getComponentName(pressableFiber) || 'Unknown';
                        }
                        // Keep the icon child name even when the ancestor name wins — icon-only
                        // buttons get their semantics from it (SvgChevronBack → back button).
                        var childName = (!text || GENERIC_COMPONENT.test(componentName)) ? findMeaningfulChildName(pressableFiber) : null;
                        if (childName && GENERIC_COMPONENT.test(componentName)) componentName = childName;
                        var path = buildPath(pressableFiber);

                        // testID/accessibilityLabel are spread onto the host view by TouchableOpacity etc.
                        var hostProps = hostFiber.memoizedProps || {};
                        var testID = hostProps.testID || hostProps.nativeID || pressableProps.testID || pressableProps.nativeID || null;
                        var accessibilityLabel = hostProps.accessibilityLabel || pressableProps.accessibilityLabel || null;

                        var hostIdx = hostFibers.length;
                        hostFibers.push(hostFiber);
                        fiberMeta.push({
                            component: componentName,
                            path: path,
                            text: text ? text.slice(0, 100) : '',
                            testID: testID,
                            accessibilityLabel: accessibilityLabel,
                            isInput: false,
                            icon: childName || null,
                            hostIndices: [hostIdx]
                        });
                    }
                    // Do not recurse into PressabilityDebugView's own children (debug overlay)
                    return;
                }

                var child = fiber.child;
                while (child) {
                    walkPressabilityDebugViews(child, depth + 1, nextHidden);
                    child = child.sibling;
                }
            }

            if (anyPDV) {
                walkPressabilityDebugViews(roots[0].current, 0, false);
                walkInputs(roots[0].current, 0);
            } else {
                // Fallback: original onPress-based detection for production builds
                walkPressables(roots[0].current, 0);
            }

            // Collect text fibers that are NOT inside a pressable — used later to attach
            // spatial 'nearbyText' hints to icon-only pressables.
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

                // Track hidden-screen ancestry without early return — a MaybeScreen wrapper
                // can enclose BOTH the active and inactive siblings, so we must keep walking
                // to find the active one while still skipping the inactive subtree's texts.
                var nextHidden = inHidden;
                if (name === 'MaybeScreen' && props && props.active === 0) nextHidden = true;
                if (name === 'SceneView' && props && props.focused === false) nextHidden = true;
                if (name === 'RNSScreen' && props && props['aria-hidden'] === true) nextHidden = true;

                var hasOnPress = props && typeof props.onPress === 'function';
                var isInputHere = props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');
                var nextInside = insidePressable || !!hasOnPress || !!isInputHere;

                // Record standalone text when outside any pressable. Detects both stock
                // Text and custom wrappers (CustomText, ThemedText, etc.) by checking for
                // direct string/number children. Fabric RCTText has no publicInstance, so
                // we walk up the fiber chain to the nearest measurable host (the View
                // enclosing the text) and use its frame as the text's proxy bounds.
                if (!insidePressable && !nextHidden && name !== 'RCTText' && typeof fiber.type !== 'string') {
                    var str = extractTextString(fiber);
                    if (str && str.length > 0 && str.length <= 120) {
                        var up = fiber;
                        var upDepth = 0;
                        var measurable = null;
                        while (up && upDepth < 20) {
                            if (typeof up.type === 'string' && getMeasurable(up)) {
                                measurable = up;
                                break;
                            }
                            up = up.return;
                            upDepth++;
                        }
                        if (measurable) {
                            textFibers.push(measurable);
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

            if (hostFibers.length === 0) return { error: 'No pressable elements found on screen.' };

            // Also measure the root view for viewport detection (appended; tracked by explicit index to preserve hostIndices)
            var rootHost = findFirstHost(roots[0].current, 0);
            var rootIdx = -1;
            if (rootHost) {
                rootIdx = hostFibers.length;
                hostFibers.push(rootHost);
            }

            globalThis.__pressableFibers = hostFibers;
            globalThis.__pressableMeta = fiberMeta;
            globalThis.__pressableMeasurements = new Array(hostFibers.length).fill(null);
            globalThis.__pressableRootIdx = rootIdx;

            for (var i = 0; i < hostFibers.length; i++) {
                try {
                    (function(idx) {
                        getMeasurable(hostFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                            globalThis.__pressableMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                        });
                    })(i);
                } catch(e) {}
            }

            globalThis.__pressableTextContents = textContents;
            globalThis.__pressableTextMeasurements = new Array(textFibers.length).fill(null);
            for (var ti = 0; ti < textFibers.length; ti++) {
                try {
                    (function(idx) {
                        getMeasurable(textFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                            globalThis.__pressableTextMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                        });
                    })(ti);
                } catch(e) {}
            }

            return { count: hostFibers.length, textCount: textFibers.length };
        })()
    `;

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000, originatingToolName: "get_pressable_elements" }, device);
    if (!dispatchResult.success) return dispatchResult;

    try {
        const parsed = JSON.parse(dispatchResult.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
    } catch {
        /* ignore */
    }

    // Wait for measureInWindow callbacks
    await delay(300);

    // --- Step 2: read measurements, filter visible, build results ---
    const resolveExpression = `
        (function() {
            var fibers = globalThis.__pressableFibers;
            var meta = globalThis.__pressableMeta;
            var measurements = globalThis.__pressableMeasurements;
            var rootIdx = globalThis.__pressableRootIdx;
            var textContents = globalThis.__pressableTextContents || [];
            var textMeasurements = globalThis.__pressableTextMeasurements || [];
            globalThis.__pressableFibers = null;
            globalThis.__pressableMeta = null;
            globalThis.__pressableMeasurements = null;
            globalThis.__pressableRootIdx = null;
            globalThis.__pressableTextContents = null;
            globalThis.__pressableTextMeasurements = null;

            if (!fibers || !measurements || !meta) {
                return { error: 'No measurement data. Run get_pressable_elements again.' };
            }

            // Get viewport dimensions from the explicit root measurement (fallback to scanning)
            var viewportW = 9999, viewportH = 9999;
            var rootM = (rootIdx != null && rootIdx >= 0) ? measurements[rootIdx] : null;
            if (rootM && rootM.width > 0 && rootM.height > 0) {
                viewportW = rootM.width;
                viewportH = rootM.height + (rootM.y > 0 ? rootM.y : 0);
            } else {
                for (var v = 0; v < measurements.length; v++) {
                    if (measurements[v] && measurements[v].x === 0 && measurements[v].y <= 0 &&
                        measurements[v].width > 0 && measurements[v].height > 0) {
                        viewportW = measurements[v].width;
                        viewportH = measurements[v].height + measurements[v].y;
                        break;
                    }
                }
            }

            var elements = [];

            for (var i = 0; i < meta.length; i++) {
                var info = meta[i];

                // Union all host measurements for this pressable to get its true bounds
                var uMinX = Infinity, uMinY = Infinity, uMaxX = -Infinity, uMaxY = -Infinity;
                var hasValid = false;
                var indices = info.hostIndices || [];
                for (var hi2 = 0; hi2 < indices.length; hi2++) {
                    var mm = measurements[indices[hi2]];
                    if (!mm || mm.width <= 0 || mm.height <= 0) continue;
                    hasValid = true;
                    if (mm.x < uMinX) uMinX = mm.x;
                    if (mm.y < uMinY) uMinY = mm.y;
                    if (mm.x + mm.width > uMaxX) uMaxX = mm.x + mm.width;
                    if (mm.y + mm.height > uMaxY) uMaxY = mm.y + mm.height;
                }
                if (!hasValid) continue;
                var m = { x: uMinX, y: uMinY, width: uMaxX - uMinX, height: uMaxY - uMinY };

                // Filter: only visible within viewport
                if (m.width <= 0 || m.height <= 0) continue;
                if (m.x + m.width < 0 || m.y + m.height < 0) continue;
                if (m.x > viewportW || m.y > viewportH) continue;

                var text = info.text || '';

                elements.push({
                    component: info.component,
                    path: info.path,
                    center: {
                        x: Math.round(m.x + m.width / 2),
                        y: Math.round(m.y + m.height / 2)
                    },
                    frame: {
                        x: Math.round(m.x),
                        y: Math.round(m.y),
                        width: Math.round(m.width),
                        height: Math.round(m.height)
                    },
                    text: text,
                    testID: info.testID,
                    accessibilityLabel: info.accessibilityLabel,
                    hasLabel: text.length > 0,
                    isInput: info.isInput,
                    icon: info.icon || null
                });
            }

            // Deduplicate: multiple nested pressables (View > TouchableOpacity > TouchableOpacity)
            // often share the same frame. Keep the one with the most meaningful component name,
            // but merge text/testID/accessibilityLabel from the loser so stopping collectText
            // at nested-pressable boundaries does not drop labels across the merge.
            var HOST_NAMES = /^(View|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Pressable|TouchableNativeFeedback|Text|RCTView|RCTText)$/;
            function mergeFields(winner, loser) {
                if (!winner.text && loser.text) {
                    winner.text = loser.text;
                    winner.hasLabel = winner.text.length > 0;
                }
                if (!winner.testID && loser.testID) winner.testID = loser.testID;
                if (!winner.accessibilityLabel && loser.accessibilityLabel) winner.accessibilityLabel = loser.accessibilityLabel;
                if (!winner.icon && loser.icon) winner.icon = loser.icon;
                return winner;
            }
            var deduped = {};
            for (var di = 0; di < elements.length; di++) {
                var el = elements[di];
                var key = el.frame.x + ',' + el.frame.y + ',' + el.frame.width + ',' + el.frame.height;
                var existing = deduped[key];
                if (!existing) {
                    deduped[key] = el;
                } else {
                    var existingIsGeneric = HOST_NAMES.test(existing.component);
                    var newIsGeneric = HOST_NAMES.test(el.component);
                    var winner, loser;
                    if (existingIsGeneric && !newIsGeneric) {
                        winner = el; loser = existing;
                    } else if (!existingIsGeneric && newIsGeneric) {
                        winner = existing; loser = el;
                    } else {
                        // Both generic or both meaningful — prefer the one with more identifiers.
                        if (!existing.testID && el.testID) { winner = el; loser = existing; }
                        else if (!existing.accessibilityLabel && el.accessibilityLabel) { winner = el; loser = existing; }
                        else { winner = existing; loser = el; }
                    }
                    deduped[key] = mergeFields(winner, loser);
                }
            }
            elements = [];
            for (var dk in deduped) {
                elements.push(deduped[dk]);
            }

            // Tag wrappers: pressables that cover >=50% of viewport AND geometrically contain another pressable.
            // These are typically keyboard-dismiss/full-screen Touchable wrappers — agents should skip them.
            var viewportArea = (viewportW > 0 && viewportH > 0 && viewportW < 9999 && viewportH < 9999)
                ? viewportW * viewportH : 0;
            if (viewportArea > 0) {
                for (var wi = 0; wi < elements.length; wi++) {
                    var we = elements[wi];
                    var weArea = we.frame.width * we.frame.height;
                    if (weArea < viewportArea * 0.5) continue;
                    for (var wj = 0; wj < elements.length; wj++) {
                        if (wj === wi) continue;
                        var other = elements[wj];
                        if (other.frame.x >= we.frame.x &&
                            other.frame.y >= we.frame.y &&
                            other.frame.x + other.frame.width <= we.frame.x + we.frame.width &&
                            other.frame.y + other.frame.height <= we.frame.y + we.frame.height &&
                            other.frame.width * other.frame.height < weArea) {
                            we.isWrapper = true;
                            break;
                        }
                    }
                }
            }

            // Build a normalized list of visible standalone texts (content + frame)
            var textBoxes = [];
            for (var tmi = 0; tmi < textMeasurements.length; tmi++) {
                var tm = textMeasurements[tmi];
                var tc = textContents[tmi];
                if (!tm || !tc) continue;
                if (tm.width <= 0 || tm.height <= 0) continue;
                if (tm.x + tm.width < 0 || tm.y + tm.height < 0) continue;
                if (tm.x > viewportW || tm.y > viewportH) continue;
                textBoxes.push({
                    text: tc,
                    x: tm.x, y: tm.y, width: tm.width, height: tm.height,
                    cx: tm.x + tm.width / 2, cy: tm.y + tm.height / 2
                });
            }

            // Humanize component name → intent (strip Svg/Icon prefixes, split camelCase)
            function humanize(name) {
                if (!name) return '';
                var n = String(name);
                n = n.replace(/^(Svg|Icon)/, '').replace(/(Svg|Icon)$/, '');
                n = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
                n = n.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
                return n.trim().toLowerCase();
            }

            // Attach nearbyText for pressables that lack their own text/label.
            // Nearest text by center-to-center distance, within a reasonable radius.
            var NEARBY_RADIUS = 120; // points
            for (var ei = 0; ei < elements.length; ei++) {
                var pe = elements[ei];
                pe.intent = humanize(pe.icon || pe.component);
                // Skip when the pressable already has its own human-readable text or a11y label.
                // testID alone doesn't suppress nearbyText — the testID may be cryptic and the
                // surrounding visible text is still a useful handle for an agent.
                if (pe.hasLabel || pe.accessibilityLabel) continue;
                if (textBoxes.length === 0) continue;

                var pcx = pe.frame.x + pe.frame.width / 2;
                var pcy = pe.frame.y + pe.frame.height / 2;
                var best = null;
                var bestDist = Infinity;
                for (var tbi = 0; tbi < textBoxes.length; tbi++) {
                    var tb = textBoxes[tbi];
                    // Skip texts contained inside this pressable (shouldn't happen — walkTexts excludes them — but defensive)
                    if (tb.x >= pe.frame.x && tb.y >= pe.frame.y &&
                        tb.x + tb.width <= pe.frame.x + pe.frame.width &&
                        tb.y + tb.height <= pe.frame.y + pe.frame.height) continue;
                    // Row siblings first: a checkbox's label sits in the same row but its
                    // long text's CENTER is far away, so center distance alone misses it.
                    // Row-aligned + small horizontal edge gap = strongest signal.
                    var rowAligned = Math.abs(tb.cy - pcy) <= Math.max(24, pe.frame.height / 2);
                    var gapL = pe.frame.x - (tb.x + tb.width);
                    var gapR = tb.x - (pe.frame.x + pe.frame.width);
                    var hGap = Math.max(gapL, gapR);
                    if (hGap < 0) hGap = 0;
                    var d;
                    if (rowAligned && hGap <= 80) {
                        d = hGap;
                    } else {
                        var dx = tb.cx - pcx;
                        var dy = tb.cy - pcy;
                        d = Math.sqrt(dx * dx + dy * dy);
                        if (d > NEARBY_RADIUS) continue;
                    }
                    if (d < bestDist) {
                        bestDist = d;
                        best = tb;
                    }
                }
                if (best) pe.nearbyText = best.text;
            }

            // Sort top-to-bottom, left-to-right
            elements.sort(function(a, b) {
                if (a.center.y !== b.center.y) return a.center.y - b.center.y;
                return a.center.x - b.center.x;
            });

            var iconCount = 0;
            var labeledCount = 0;
            for (var j = 0; j < elements.length; j++) {
                if (elements[j].hasLabel) labeledCount++;
                else iconCount++;
            }

            return {
                pressableElements: elements,
                summary: 'Found ' + elements.length + ' pressable elements (' + iconCount + ' icon-only, ' + labeledCount + ' with text labels)'
            };
        })()
    `;

    const result = await executeInApp(resolveExpression, false, { timeoutMs: 30000, originatingToolName: "get_pressable_elements" }, device);

    if (result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.error) return { success: false, error: parsed.error };

            const pressableElements: PressableElement[] = parsed.pressableElements || [];

            // Android coordinate reconciliation (2026-05-17).
            //
            // The fiber walker produces rich metadata (component names, testID, intent,
            // wrapper flags, nearbyText) but its measureInWindow output on Bridgeless/Fabric
            // is in app-window DP space — off from the actual screen-pixel hit area by the
            // status bar height (varies per device) AND an additional unaccounted offset
            // we couldn't characterize across devices.
            //
            // uiautomator's bounds, on the other hand, are in absolute display pixels and
            // match what tap(x, y) → adb input dispatches — they are touch-accurate.
            //
            // Strategy: keep fiber's metadata, but replace coords with uiautomator's bounds
            // when we can match a fiber element to a uiautomator node by text / contentDesc /
            // resourceId. For icon-only pressables that have no text-match candidate,
            // fall back to fiber's DP coords scaled by density — they're imperfect but
            // they keep the same gross layout that an agent could use as a "near this
            // region" hint, and they're better than nothing.
            //
            // iOS is unaffected — fiber returns points and AXe returns points; uniform.
            if (effectivePlatform === "android" && pressableElements.length > 0) {
                let densityScale = 2.625;
                let statusBarPixels = 0;
                try {
                    const { androidGetDensity, androidGetStatusBarHeight } = await import("./android.js");
                    const [densityResult, statusBarResult] = await Promise.all([
                        androidGetDensity(),
                        androidGetStatusBarHeight().catch(() => ({ success: false, heightPixels: 0 }) as const),
                    ]);
                    densityScale = (densityResult.density || 420) / 160;
                    if (statusBarResult.success && statusBarResult.heightPixels) {
                        statusBarPixels = statusBarResult.heightPixels;
                    }
                } catch { /* default */ }

                let uiNodes: import("./android.js").AndroidUIElement[] | undefined;
                try {
                    const { androidGetUITree } = await import("./android.js");
                    const tree = await androidGetUITree();
                    if (tree.success && tree.elements) uiNodes = tree.elements;
                } catch { /* uiautomator unavailable */ }

                const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
                const findUiMatch = (el: PressableElement): import("./android.js").AndroidUIElement | null => {
                    if (!uiNodes || uiNodes.length === 0) return null;
                    const targetTestID = norm(el.testID);
                    const targetText = norm(el.text);
                    const targetA11y = norm(el.accessibilityLabel);
                    if (!targetTestID && !targetText && !targetA11y) return null;
                    // Prefer testID → resourceId exact match (most stable).
                    if (targetTestID) {
                        const m = uiNodes.find(u => norm(u.resourceId).endsWith("/" + targetTestID) || norm(u.resourceId) === targetTestID);
                        if (m) return m;
                    }
                    // Then exact text/contentDesc match.
                    for (const query of [targetText, targetA11y]) {
                        if (!query) continue;
                        const m = uiNodes.find(u => norm(u.text) === query || norm(u.contentDesc) === query);
                        if (m) return m;
                    }
                    // Then substring — handles fiber's collected text being a superset of one node's label.
                    for (const query of [targetText, targetA11y]) {
                        if (!query) continue;
                        const m = uiNodes.find(u => {
                            const ut = norm(u.text);
                            const ud = norm(u.contentDesc);
                            return (ut && (ut.includes(query) || query.includes(ut))) ||
                                   (ud && (ud.includes(query) || query.includes(ud)));
                        });
                        if (m) return m;
                    }
                    return null;
                };

                for (const el of pressableElements) {
                    const match = findUiMatch(el);
                    if (match) {
                        el.center = { x: match.center.x, y: match.center.y };
                        el.frame = {
                            x: match.bounds.left,
                            y: match.bounds.top,
                            width: match.bounds.width,
                            height: match.bounds.height,
                        };
                    } else {
                        // Fall back to fiber's DP → device-pixel scaling, plus the dynamic
                        // status-bar pixel offset so the y origin lines up with display
                        // coordinates (uiautomator's space). measureInWindow on Bridgeless
                        // returns coordinates relative to the React window which sits
                        // below the system status bar on non-edge-to-edge apps; without
                        // this shift, fallback elements report y-values that are
                        // ~status-bar-height too small.
                        //
                        // Note: this is a best-effort correction. Edge-to-edge apps where
                        // the React window starts at the display origin will see a
                        // small over-correction here. The proper fix would query
                        // WindowInsets, but the data isn't exposed via adb in a way
                        // we can reach today, and the icon-only-no-text fallback is
                        // already a "region hint" path — agents should prefer
                        // tap(component=...) / tap(testID=...) for precision.
                        el.center = {
                            x: el.center.x * densityScale,
                            y: el.center.y * densityScale + statusBarPixels,
                        };
                        el.frame = {
                            x: el.frame.x * densityScale,
                            y: el.frame.y * densityScale + statusBarPixels,
                            width: el.frame.width * densityScale,
                            height: el.frame.height * densityScale,
                        };
                    }
                }
            }

            // Format as readable text
            const lines: string[] = [parsed.summary, ""];
            for (let i = 0; i < pressableElements.length; i++) {
                const el = pressableElements[i];
                const num = i + 1;
                const iconHint = !el.hasLabel ? iconLabel(el.component, el.icon) : null;
                const label = el.hasLabel
                    ? `"${el.text}"`
                    : iconHint
                      ? `(${iconHint})`
                      : el.intent
                        ? `(${el.intent} icon)`
                        : "(icon/image)";
                const ids: string[] = [];
                if (el.testID) ids.push(`testID="${el.testID}"`);
                if (el.accessibilityLabel) ids.push(`a11y="${el.accessibilityLabel}"`);
                const idStr = ids.length > 0 ? ` [${ids.join(", ")}]` : "";
                const inputStr = el.isInput ? " (input)" : "";
                const wrapperStr = el.isWrapper ? " [wrapper — skip unless dismissing keyboard]" : "";
                const nearPart = el.nearbyText ? ` near "${el.nearbyText}"` : "";
                lines.push(
                    `${num}. ${el.component} ${label}${nearPart} — center:(${el.center.x},${el.center.y}) frame:(${el.frame.x},${el.frame.y} ${el.frame.width}x${el.frame.height})${idStr}${inputStr}${wrapperStr}`
                );
                if (el.path) lines.push(`   path: ${el.path}`);
            }

            return {
                success: true,
                result: lines.join("\n"),
                parsedElements: pressableElements
            };
        } catch {
            // If parsing fails, return original result
        }
    }

    return result;
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
}): Promise<ExecutionResult> {
    const { text, testID, component, index = 0, maxTraversalDepth = 15 } = options;

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

            var RN_PRIMITIVES = /^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|ScrollViewContext(Base)?|VirtualizedListContext(Resetter)?|TextInputContext|KeyboardAvoidingViewContext|RCT.*|RNS.*|RNC.*|ViewManagerAdapter_.*|VirtualizedList.*|CellRenderer.*|FrameSizeProvider.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|SafeAreaProvider.*|SafeAreaFrameContext|SafeAreaInsetsContext|ExpoRoot|ExpoRootComponent|GestureHandler.*|NativeViewGestureHandler|GestureDetector|PanGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|KeyboardProvider|PortalProviderComponent|BottomSheetModalProviderWrapper|ThemeContext|ThemeProvider|TextAncestorContext|PressabilityDebugView|TouchableHighlightImpl|StatusBarOverlay|BottomSheetHostingContainerComponent|BottomSheetGestureHandlersProvider|BottomSheetBackdropContainerComponent|BottomSheetContainerComponent|BottomSheetDraggableViewComponent|BottomSheetHandleContainerComponent|BottomSheetBackgroundContainerComponent|DebuggingOverlay|InspectorDeferred|Inspector|InspectorOverlay|InspectorPanel|StyleInspector|BoxInspector|BoxContainer|ElementBox|BorderBox|InspectorPanelButton)$/;

            function isScreenHidden(name, props) {
                if (!props) return false;
                if (name === 'RNSScreen' && props['aria-hidden'] === true) return true;
                if (name === 'MaybeScreen' && props.active === 0) return true;
                if (name === 'SceneView' && props.focused === false) return true;
                return false;
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

                var isPressable = props && typeof props.onPress === 'function';
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
                        var dIsPressable = fp && typeof fp.onPress === 'function';
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
                            var nIsPressable = props && typeof props.onPress === 'function';
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
                                        source: 'testID-direct'
                                    });
                                }
                            } else {
                                var foundAncestor = false;
                                var parent = fiber.return;
                                var d = 0;
                                while (parent && d < maxTraversalUp) {
                                    var pp = parent.memoizedProps;
                                    var pIsPressable = pp && typeof pp.onPress === 'function';
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
                        if (fp && typeof fp.onPress === 'function') return fiber;
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
                                if (pp && typeof pp.onPress === 'function') {
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

            // Store host fibers and metadata globally for step 2, dispatch measureInWindow
            globalThis.__tapHostFibers = hostFibers;
            globalThis.__tapMeta = tapMeta;
            globalThis.__tapMeasurements = new Array(hostFibers.length).fill(null);

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

    // Wait for measureInWindow callbacks
    await delay(300);

    // --- Step 2: Read measurements, filter visible, match by query ---
    const resolveExpression = `
        (function() {
            var hostFibers = globalThis.__tapHostFibers;
            var meta = globalThis.__tapMeta;
            var measurements = globalThis.__tapMeasurements;
            globalThis.__tapHostFibers = null;
            globalThis.__tapMeta = null;
            globalThis.__tapMeasurements = null;

            if (!hostFibers || !measurements || !meta) {
                return { error: 'No measurement data. Dispatch step may have failed.' };
            }

            var searchText = ${textParam};
            var searchTestID = ${testIDParam};
            var searchComponent = ${componentParam};
            var targetIndex = ${index};

            // Determine viewport bounds
            var viewportW = 9999, viewportH = 9999;
            for (var v = 0; v < measurements.length; v++) {
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
            for (var i = 0; i < measurements.length; i++) {
                var m = measurements[i];
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
                isInput: target.isInput
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
