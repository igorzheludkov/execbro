export * from "./jsExecute.js";
export * from "./debugGlobals.js";
export * from "./componentTree.js";

import WebSocket from "ws";
import { ExecutionResult, ExecuteOptions } from "./types.js";
import { pendingExecutions, getNextMessageId, connectedApps } from "./state.js";
import { getFirstConnectedApp, getConnectedAppByDevice, getConnectedAppBySimulatorUdid, getConnectedAppByAndroidDeviceId, connectToDevice, clearReconnectionSuppression, purgeStaleConnectionsForPorts } from "./connection.js";
import { fetchDevices, selectMainDevice, filterDebuggableDevices, scanMetroPorts } from "./metro.js";
import type { DeviceInfo } from "./types.js";
import { DEFAULT_RECONNECTION_CONFIG, cancelReconnectionTimer } from "./connectionState.js";
import { validateAndPreprocessExpression, executeInApp, delay } from "./jsExecute.js";



interface ScreenElement {
    component: string;
    path: string;
    depth: number;
    frame?: { x: number; y: number; width: number; height: number };
    layout?: Record<string, unknown>;
    text?: string;
    identifiers?: Record<string, string>;
    parentIndex?: number;
    originalIndex?: number;
}


/**
 * Classify each root as "screen" or "overlay".
 *
 * A root is a **screen** if its subtree contains a navigation screen marker
 * (Route(...), *Screen, *Page). Falls back to the largest root by area
 * if no navigation markers are found. Everything else is an overlay.
 */
function classifyRoots(
    roots: number[],
    elements: { component: string; frame?: { x: number; y: number; width: number; height: number } }[],
    childrenMap: Map<number, number[]>
): { labels: string[]; hasOverlays: boolean } {
    const labels: string[] = [];

    // Navigation screen markers: Route(...) wrapper or user-defined *Screen/*Page
    const screenMarker = /^(Route\(|.*Screen\(|.*Page\(|.*Screen$|.*Page$)/;

    function subtreeHasScreen(idx: number, depth: number): boolean {
        if (depth > 30) return false;
        if (screenMarker.test(elements[idx].component)) return true;
        const kids = childrenMap.get(idx);
        if (kids) {
            for (const kid of kids) {
                if (subtreeHasScreen(kid, depth + 1)) return true;
            }
        }
        return false;
    }

    // First pass: check which roots contain a navigation screen
    const hasScreen: boolean[] = roots.map(ri => subtreeHasScreen(ri, 0));
    const anyScreenFound = hasScreen.some(Boolean);

    if (anyScreenFound) {
        for (let i = 0; i < roots.length; i++) {
            labels.push(hasScreen[i] ? "screen" : "overlay");
        }
    } else {
        // Fallback: largest root by area is the screen
        let maxArea = 0;
        let maxIdx = 0;
        for (let i = 0; i < roots.length; i++) {
            const f = elements[roots[i]].frame;
            if (f && f.width * f.height > maxArea) {
                maxArea = f.width * f.height;
                maxIdx = i;
            }
        }
        for (let i = 0; i < roots.length; i++) {
            labels.push(i === maxIdx ? "screen" : "overlay");
        }
    }

    return { labels, hasOverlays: labels.some(l => l === "overlay") };
}

interface LayoutNode {
    component: string;
    frame?: { x: number; y: number; width: number; height: number };
    text?: string;
    identifiers?: Record<string, string>;
    parentIndex?: number;
    originalIndex?: number;
}

/**
 * Build, collapse, classify, and render a layout tree.
 *
 * Shared by both get_screen_layout (points, no tap coords) and
 * the screenshot layout enrichment (pixels, with tap coords).
 *
 * @param elements - flat list of layout nodes with parentIndex linkage
 * @param renderLine - callback that produces the output line for a node,
 *   given (element, indent level, whether it's a leaf)
 */
function formatLayoutTree<T extends LayoutNode>(
    elements: T[],
    renderLine: (el: T, indent: number, isLeaf: boolean) => string
): string {
    // Build index: originalIndex -> element index in the filtered array
    const indexMap = new Map<number, number>();
    for (let i = 0; i < elements.length; i++) {
        if (elements[i].originalIndex !== undefined) {
            indexMap.set(elements[i].originalIndex!, i);
        }
    }

    // Build children lists
    const children = new Map<number, number[]>();
    const roots: number[] = [];
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const parentOrigIdx = el.parentIndex;
        if (parentOrigIdx === undefined || parentOrigIdx === -1 || !indexMap.has(parentOrigIdx)) {
            roots.push(i);
        } else {
            const parentIdx = indexMap.get(parentOrigIdx)!;
            if (!children.has(parentIdx)) children.set(parentIdx, []);
            children.get(parentIdx)!.push(i);
        }
    }

    // Collapse wrapper chains: if a child has the same frame as its parent,
    // it's just a wrapper — promote its children and text to the parent
    function sameFrame(a: LayoutNode, b: LayoutNode): boolean {
        if (!a.frame || !b.frame) return false;
        return Math.abs(a.frame.x - b.frame.x) < 1 &&
               Math.abs(a.frame.y - b.frame.y) < 1 &&
               Math.abs(a.frame.width - b.frame.width) < 1 &&
               Math.abs(a.frame.height - b.frame.height) < 1;
    }

    function collapseNode(parentIdx: number) {
        const kids = children.get(parentIdx);
        if (!kids) return;

        const newKids: number[] = [];
        for (const kidIdx of kids) {
            if (sameFrame(elements[parentIdx], elements[kidIdx])) {
                if (!elements[parentIdx].text && elements[kidIdx].text) {
                    elements[parentIdx].text = elements[kidIdx].text;
                }
                const grandKids = children.get(kidIdx);
                if (grandKids) {
                    newKids.push(...grandKids);
                }
            } else {
                newKids.push(kidIdx);
            }
        }

        if (newKids.length > 0) {
            children.set(parentIdx, newKids);
        } else {
            children.delete(parentIdx);
        }

        const updatedKids = children.get(parentIdx);
        if (updatedKids) {
            for (const kid of updatedKids) {
                collapseNode(kid);
            }
        }
    }

    for (const root of roots) {
        collapseNode(root);
    }

    // Render tree
    const lines: string[] = [];

    function printNode(idx: number, indent: number) {
        const isLeaf = !children.has(idx);
        lines.push(renderLine(elements[idx], indent, isLeaf));
        const kids = children.get(idx);
        if (kids) {
            for (const kid of kids) {
                printNode(kid, indent + 1);
            }
        }
    }

    // Classify roots and emit layer headers
    const { labels, hasOverlays } = classifyRoots(roots, elements, children);

    if (hasOverlays) {
        let prevLabel = "";
        for (let ri = 0; ri < roots.length; ri++) {
            const label = labels[ri];
            if (label === "overlay" || label !== prevLabel) {
                if (lines.length > 0) lines.push("");
                lines.push(`[${label}]`);
            }
            prevLabel = label;
            printNode(roots[ri], 0);
        }
    } else {
        for (const root of roots) {
            printNode(root, 0);
        }
    }

    return lines.join("\n");
}

export function formatScreenLayoutTree(
    elements: ScreenElement[],
    extended: boolean = false,
    offScreen?: { offScreenBelow?: string[]; offScreenAbove?: string[] }
): string {
    const tree = formatLayoutTree(elements, (el, indent, isLeaf) => {
        const prefix = "  ".repeat(indent);
        const frame = el.frame
            ? ` (${Math.round(el.frame.x)},${Math.round(el.frame.y)} ${Math.round(el.frame.width)}x${Math.round(el.frame.height)})`
            : "";
        const id = el.identifiers?.testID || el.identifiers?.accessibilityLabel || "";
        const idStr = id ? ` [${id}]` : "";
        const textStr = el.text && isLeaf ? ` "${el.text}"` : "";
        const layoutStr = extended && el.layout
            ? ` {${Object.entries(el.layout).map(([k, v]) => `${k}:${v}`).join("; ")}}`
            : "";
        return `${prefix}${el.component}${frame}${idStr}${textStr}${layoutStr}`;
    });
    const suffix: string[] = [];
    if (offScreen?.offScreenAbove?.length) {
        suffix.push(formatOffScreenLine(offScreen.offScreenAbove, "above fold"));
    }
    if (offScreen?.offScreenBelow?.length) {
        suffix.push(formatOffScreenLine(offScreen.offScreenBelow, "below fold"));
    }
    return suffix.length > 0 ? `${tree}\n\n${suffix.join("\n")}` : tree;
}

function formatOffScreenLine(names: string[], position: string): string {
    const total = names.length;
    const CAP = 10;
    if (total <= CAP) {
        return `[... ${total} component${total === 1 ? "" : "s"} ${position}: ${names.join(", ")}]`;
    }
    const shown = names.slice(0, CAP).join(", ");
    return `[... ${total} components ${position}: ${shown}, ... +${total - CAP} more]`;
}

interface FoundComponent {
    component: string;
    path: string;
    depth: number;
    key?: string;
    testID?: string;
    layout?: Record<string, unknown>;
}

function formatFoundComponentsToTonl(components: FoundComponent[]): string {
    const lines: string[] = ["#found{component,path,depth,key,layout}"];
    for (const c of components) {
        const layout = c.layout
            ? Object.entries(c.layout)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(";")
            : "";
        lines.push(`${c.component}|${c.path}|${c.depth}|${c.key || ""}|${layout}`);
    }
    return lines.join("\n");
}

interface ComponentSummary {
    component: string;
    count: number;
}

function formatSummaryToTonl(components: ComponentSummary[], total: number): string {
    const lines: string[] = [`#summary total=${total}`];
    for (const c of components) {
        lines.push(`${c.component}:${c.count}`);
    }
    return lines.join("\n");
}

/**
 * Get the React component tree from the running app.
 * This traverses the fiber tree to extract component hierarchy with names.
 */

/**
 * Get layout data for visible components on the current screen.
 * Uses measureInWindow to get actual screen positions and filters
 * to only components within the viewport.
 *
 * Two-step approach (same as inspectAtPoint):
 * Step 1: Walk fiber tree, dispatch measureInWindow on host components
 * Step 2: After 300ms, read measurements, filter by viewport, build results
 */
export async function getScreenLayout(
    options: {
        extended?: boolean;
        summary?: boolean;
        device?: string;
        raw?: boolean;
    } = {}
): Promise<ExecutionResult & {
    parsedElements?: ScreenElement[];
    viewport?: { width: number; height: number };
    offScreenBelow?: string[];
    offScreenAbove?: string[];
}> {
    const { extended = false, summary = false, device, raw = false } = options;
    const maxDepth = 5000;
    const componentsOnly = true;
    const shortPath = true;

    // --- Step 1: walk fiber tree + dispatch measureInWindow calls ---
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

            // Collect host fibers with their metadata
            var hostFibers = [];
            var fiberMeta = [];
            var componentsOnlyMode = ${componentsOnly};

            // RN internals and primitives — skip these when looking for meaningful component names
            // Only filter internal components that can't be written as JSX.
            // Keep all user-facing components (View, Text, ScrollView, Modal, etc.)
            var RN_PRIMITIVES = /^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|ScrollViewContext(Base)?|VirtualizedListContext(Resetter)?|TextInputContext|KeyboardAvoidingViewContext|RCT.*|RNS.*|RNC.*|ViewManagerAdapter_.*|VirtualizedList.*|CellRenderer.*|FrameSizeProvider.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|SafeAreaProvider.*|SafeAreaFrameContext|SafeAreaInsetsContext|ExpoRoot|ExpoRootComponent|GestureHandler.*|NativeViewGestureHandler|GestureDetector|PanGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|KeyboardProvider|PortalProviderComponent|BottomSheetModalProviderWrapper|ThemeContext|ThemeProvider|TextAncestorContext|PressabilityDebugView|TouchableHighlightImpl|StatusBarOverlay|BottomSheetHostingContainerComponent|BottomSheetGestureHandlersProvider|BottomSheetBackdropContainerComponent|BottomSheetContainerComponent|BottomSheetDraggableViewComponent|BottomSheetHandleContainerComponent|BottomSheetBackgroundContainerComponent|DebuggingOverlay|InspectorDeferred|Inspector|InspectorOverlay|InspectorPanel|StyleInspector|BoxInspector|BoxContainer|ElementBox|BorderBox|InspectorPanelButton)$/;

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            // Find the first measurable host descendant of a fiber
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

            // Extract text content from a fiber subtree.
            // When a fiber has a string child, return it without recursing
            // (avoids duplication from Text > RCTText having the same string).
            function collectText(fiber, d) {
                if (!fiber || d > 30) return '';
                var props = fiber.memoizedProps;
                if (props) {
                    var ch = props.children;
                    // Leaf text — return without recursing into children fibers
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
                // No direct text — collect from child fibers (siblings = adjacent elements)
                var parts = [];
                var child = fiber.child;
                while (child) {
                    var t = collectText(child, d + 1);
                    if (t) parts.push(t);
                    child = child.sibling;
                }
                return parts.join(' ').trim();
            }

            if (componentsOnlyMode) {
                // componentsOnly: walk tree looking for meaningful custom components,
                // measure their first host child, track parent for tree output
                function walkComponents(fiber, depth, path, parentIdx, ancestors) {
                    if (!fiber || depth > ${maxDepth}) return;
                    var name = getComponentName(fiber);
                    var isHost = typeof fiber.type === 'string';

                    // Skip inactive screens (react-native-screens MaybeScreen with active=0)
                    // active: 0 = inactive/detached, 1 = transitioning, 2 = active
                    if (name === 'MaybeScreen' && fiber.memoizedProps && fiber.memoizedProps.active === 0) return;

                    // Skip unfocused screens in NativeStackNavigator (SceneView with focused=false)
                    if (name === 'SceneView' && fiber.memoizedProps && fiber.memoizedProps.focused === false) return;

                    var isMeaningful = name && !isHost && !RN_PRIMITIVES.test(name);

                    var myIdx = parentIdx;
                    var nextAncestors = ancestors;
                    if (isMeaningful) {
                        var host = findFirstHost(fiber, 0);
                        if (host) {
                            myIdx = hostFibers.length;
                            // Extract text from this component's subtree
                            var text = collectText(fiber, 0);
                            hostFibers.push(host);
                            fiberMeta.push({
                                hostName: typeof host.type === 'string' ? host.type : '',
                                customName: name,
                                depth: depth,
                                path: path.concat([name]),
                                parentIndex: parentIdx,
                                ancestorIndices: ancestors.slice(),
                                text: text ? text.slice(0, 80) : null
                            });
                            // Build the ancestor chain for descendants: [myIdx, ...previous ancestors]
                            nextAncestors = [myIdx].concat(ancestors);
                        }
                    }

                    var child = fiber.child;
                    while (child) {
                        var childName = getComponentName(child);
                        walkComponents(child, depth + 1, childName ? path.concat([childName]) : path, myIdx, nextAncestors);
                        child = child.sibling;
                    }
                }
                for (var ri = 0; ri < roots.length; ri++) {
                    walkComponents(roots[ri].current, 0, [], -1, []);
                }
            } else {
                // Default mode: collect all host fibers with ancestor info
                function walkFibers(fiber, depth, path) {
                    if (!fiber || depth > ${maxDepth}) return;
                    var name = getComponentName(fiber);
                    var isHost = typeof fiber.type === 'string';

                    // Skip inactive screens (react-native-screens MaybeScreen with active=0)
                    if (name === 'MaybeScreen' && fiber.memoizedProps && fiber.memoizedProps.active === 0) return;

                    // Skip unfocused screens in NativeStackNavigator (SceneView with focused=false)
                    if (name === 'SceneView' && fiber.memoizedProps && fiber.memoizedProps.focused === false) return;

                    if (name && isHost && getMeasurable(fiber)) {
                        // Find nearest meaningful custom component ancestor for display
                        var customName = null;
                        var fallbackName = null;
                        var cur = fiber.return;
                        while (cur) {
                            if (cur.type && typeof cur.type !== 'string') {
                                var cName = cur.type.displayName || cur.type.name || null;
                                if (cName) {
                                    if (!fallbackName) fallbackName = cName;
                                    if (!RN_PRIMITIVES.test(cName)) {
                                        customName = cName;
                                        break;
                                    }
                                }
                            }
                            cur = cur.return;
                        }
                        if (!customName) customName = fallbackName;

                        hostFibers.push(fiber);
                        fiberMeta.push({
                            hostName: name,
                            customName: customName,
                            depth: depth,
                            path: path.slice()
                        });
                    }

                    var child = fiber.child;
                    while (child) {
                        var childName = getComponentName(child);
                        walkFibers(child, depth + 1, childName ? path.concat([childName]) : path);
                        child = child.sibling;
                    }
                }
                for (var ri = 0; ri < roots.length; ri++) {
                    walkFibers(roots[ri].current, 0, []);
                }
            }

            if (hostFibers.length === 0) return { error: 'No measurable host components found.' };

            // Store fibers and metadata globally for step 2
            globalThis.__layoutFibers = hostFibers;
            globalThis.__layoutMeta = fiberMeta;
            globalThis.__layoutMeasurements = new Array(hostFibers.length).fill(null);

            // Dispatch measureInWindow on all host fibers
            for (var i = 0; i < hostFibers.length; i++) {
                try {
                    (function(idx) {
                        getMeasurable(hostFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                            globalThis.__layoutMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                        });
                    })(i);
                } catch(e) {}
            }

            return { count: hostFibers.length };
        })()
    `;

    let dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000 }, device);
    if (!dispatchResult.success) return dispatchResult;

    let dispatchError: string | undefined;
    try {
        const parsed = JSON.parse(dispatchResult.result || "{}");
        if (parsed.error) dispatchError = parsed.error;
    } catch {
        /* ignore */
    }

    // Retry once on the early-startup race where the React DevTools hook
    // isn't registered yet. Production / non-__DEV__ builds will still fail
    // after the retry — surface an actionable error pointing at OCR/screenshot.
    if (dispatchError && /React DevTools hook not found/.test(dispatchError)) {
        await delay(400);
        dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000 }, device);
        if (!dispatchResult.success) return dispatchResult;
        dispatchError = undefined;
        try {
            const parsed = JSON.parse(dispatchResult.result || "{}");
            if (parsed.error) dispatchError = parsed.error;
        } catch {
            /* ignore */
        }
        if (dispatchError && /React DevTools hook not found/.test(dispatchError)) {
            return {
                success: false,
                error:
                    "React DevTools hook not registered (likely a production / non-__DEV__ build). " +
                    "Fiber-based layout is unavailable. Use ocr_screenshot for text + tap coordinates, " +
                    "or ios_screenshot / android_screenshot for a visual snapshot.",
            };
        }
    }

    if (dispatchError) return { success: false, error: dispatchError };

    // Wait for measureInWindow callbacks
    await delay(300);

    // --- Step 2: read measurements, filter visible, build results ---
    const resolveExpression = `
        (function() {
            var fibers = globalThis.__layoutFibers;
            var meta = globalThis.__layoutMeta;
            var measurements = globalThis.__layoutMeasurements;
            globalThis.__layoutFibers = null;
            globalThis.__layoutMeta = null;
            globalThis.__layoutMeasurements = null;

            if (!fibers || !measurements || !meta) {
                return { error: 'No measurement data. Run get_screen_layout again.' };
            }

            var componentsOnly = ${componentsOnly};
            var shortPath = ${shortPath};
            var summaryMode = ${summary};
            var pathSegments = 3;


            // Get viewport dimensions from the first root view measurement
            // Accept elements starting at x=0 even with negative y (safe area extensions)
            var viewportW = 9999, viewportH = 9999;
            for (var v = 0; v < measurements.length; v++) {
                if (measurements[v] && measurements[v].x === 0 && measurements[v].y <= 0 &&
                    measurements[v].width > 0 && measurements[v].height > 0) {
                    viewportW = measurements[v].width;
                    // For wrappers extending behind safe area, the visible viewport height
                    // is the total height minus the negative offset
                    viewportH = measurements[v].height + measurements[v].y;
                    break;
                }
            }

            function formatPath(pathArray) {
                if (!shortPath || pathArray.length <= pathSegments) {
                    return pathArray.join(' > ');
                }
                return '... > ' + pathArray.slice(-pathSegments).join(' > ');
            }

            function extractLayoutStyles(style) {
                try {
                    if (!style) return null;
                    var merged = Array.isArray(style)
                        ? Object.assign.apply(null, [{}].concat(style.filter(Boolean).map(function(s) {
                            try { return typeof s === 'object' ? s : {}; }
                            catch(e) { return {}; }
                        })))
                        : (typeof style === 'object' ? style : {});

                    var layout = {};
                    var layoutKeys = [
                        'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
                        'paddingHorizontal', 'paddingVertical',
                        'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
                        'marginHorizontal', 'marginVertical',
                        'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
                        'flex', 'flexDirection', 'flexWrap', 'flexGrow', 'flexShrink',
                        'justifyContent', 'alignItems', 'alignSelf', 'alignContent',
                        'position', 'top', 'bottom', 'left', 'right',
                        'gap', 'rowGap', 'columnGap',
                        'borderWidth', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth',
                        'backgroundColor', 'borderColor', 'borderRadius',
                        'zIndex', 'elevation'
                    ];

                    for (var k = 0; k < layoutKeys.length; k++) {
                        if (merged[layoutKeys[k]] !== undefined) layout[layoutKeys[k]] = merged[layoutKeys[k]];
                    }
                    return Object.keys(layout).length > 0 ? layout : null;
                } catch(e) { return null; }
            }

            var elements = [];
            var offScreenBelow = [];
            var offScreenAbove = [];

            for (var i = 0; i < measurements.length; i++) {
                var m = measurements[i];
                if (!m) continue;

                // Filter: zero-size
                if (m.width <= 0 || m.height <= 0) continue;

                // Vertical: track off-screen above/below for the summary line
                if (m.y + m.height < 0) {
                    if (meta[i] && meta[i].customName) offScreenAbove.push({ idx: i, y: m.y });
                    continue;
                }
                if (m.y > viewportH) {
                    if (meta[i] && meta[i].customName) offScreenBelow.push({ idx: i, y: m.y });
                    continue;
                }

                // Horizontal: center must be inside the viewport (drops phantom slides at x=-411 etc.)
                var centerX = m.x + m.width / 2;
                if (centerX < 0 || centerX > viewportW) continue;

                var fiber = fibers[i];
                var info = meta[i];

                var displayName = componentsOnly ? info.customName : info.hostName;
                if (!displayName) continue;
                if (componentsOnly && !info.customName) continue;

                var style = null;
                try { style = fiber.memoizedProps ? fiber.memoizedProps.style : null; } catch {}
                var layout = extractLayoutStyles(style);

                // Get text content — use pre-collected text from step 1, or fall back to host fiber
                var textContent = info.text || null;
                if (!textContent && (info.hostName === 'RCTText' || info.hostName === 'Text')) {
                    var children = null;
                    try { children = fiber.memoizedProps ? fiber.memoizedProps.children : null; } catch {}
                    if (typeof children === 'string') textContent = children;
                    else if (typeof children === 'number') textContent = String(children);
                }

                var element = {
                    component: displayName,
                    path: formatPath(info.path),
                    depth: info.depth,
                    frame: { x: m.x, y: m.y, width: m.width, height: m.height },
                    originalIndex: i
                };

                if (info.parentIndex !== undefined) element.parentIndex = info.parentIndex;
                if (layout) element.layout = layout;
                if (textContent) element.text = textContent.slice(0, 100);

                // Identifiers
                if (fiber.memoizedProps) {
                    var identifiers = {};
                    if (fiber.memoizedProps.testID) identifiers.testID = fiber.memoizedProps.testID;
                    if (fiber.memoizedProps.accessibilityLabel) identifiers.accessibilityLabel = fiber.memoizedProps.accessibilityLabel;
                    if (fiber.memoizedProps.nativeID) identifiers.nativeID = fiber.memoizedProps.nativeID;
                    if (fiber.key) identifiers.key = fiber.key;
                    if (Object.keys(identifiers).length > 0) element.identifiers = identifiers;
                }

                elements.push(element);
            }

            // In componentsOnly mode, remove full-screen wrapper components
            // and re-parent their children to collapse the wrapper chain
            if (componentsOnly && elements.length > 0) {
                var filtered = [];
                // Map: originalIndex -> resolved parent for skipped wrappers
                var reparent = {};

                for (var fi = 0; fi < elements.length; fi++) {
                    var el = elements[fi];
                    var fr = el.frame;
                    // A wrapper is full-screen if it covers the entire viewport or extends beyond it
                    // (e.g., y=-119 wrappers that extend behind the safe area)
                    var isFullScreen = fr && fr.x <= 0 && fr.y <= 0 &&
                        (fr.width >= viewportW - 2) && (fr.y + fr.height >= viewportH - 2);

                    if (isFullScreen) {
                        // Skip this wrapper, map its originalIndex to its parent
                        reparent[el.originalIndex] = el.parentIndex;
                    } else {
                        // Resolve parent through any skipped wrappers
                        var resolvedParent = el.parentIndex;
                        while (resolvedParent !== undefined && resolvedParent !== -1 && reparent[resolvedParent] !== undefined) {
                            resolvedParent = reparent[resolvedParent];
                        }
                        el.parentIndex = resolvedParent;
                        filtered.push(el);
                    }
                }
                elements = filtered;

                // Second pass: rewrite orphans whose parentIndex points at a non-surviving element.
                // This happens when an intermediate ancestor was dropped by the viewport filter
                // (not the full-screen wrapper path). Walk ancestorIndices to the nearest survivor.
                var surviving = {};
                for (var si = 0; si < elements.length; si++) {
                    surviving[elements[si].originalIndex] = true;
                }
                for (var oi = 0; oi < elements.length; oi++) {
                    var e2 = elements[oi];
                    if (e2.parentIndex === -1 || e2.parentIndex === undefined) continue;
                    if (surviving[e2.parentIndex]) continue;
                    var anc = meta[e2.originalIndex] && meta[e2.originalIndex].ancestorIndices;
                    if (!anc) { e2.parentIndex = -1; continue; }
                    var found = -1;
                    for (var ai = 0; ai < anc.length; ai++) {
                        if (surviving[anc[ai]]) { found = anc[ai]; break; }
                    }
                    e2.parentIndex = found;
                }
            }

            if (summaryMode) {
                var counts = {};
                for (var j = 0; j < elements.length; j++) {
                    counts[elements[j].component] = (counts[elements[j].component] || 0) + 1;
                }
                var sorted = Object.keys(counts).map(function(name) {
                    return { component: name, count: counts[name] };
                }).sort(function(a, b) { return b.count - a.count; });
                return {
                    totalElements: elements.length,
                    uniqueComponents: sorted.length,
                    components: sorted
                };
            }

            return {
                viewport: { width: viewportW, height: viewportH },
                totalElements: elements.length,
                elements: elements,
                offScreenBelow: (function() {
                    var seen = {}, out = [];
                    offScreenBelow.sort(function(a, b) { return a.y - b.y; });
                    for (var k = 0; k < offScreenBelow.length; k++) {
                        var n = meta[offScreenBelow[k].idx].customName;
                        if (n && !seen[n]) { seen[n] = true; out.push(n); }
                    }
                    return out;
                })(),
                offScreenAbove: (function() {
                    var seen = {}, out = [];
                    offScreenAbove.sort(function(a, b) { return b.y - a.y; });
                    for (var k = 0; k < offScreenAbove.length; k++) {
                        var n = meta[offScreenAbove[k].idx].customName;
                        if (n && !seen[n]) { seen[n] = true; out.push(n); }
                    }
                    return out;
                })()
            };
        })()
    `;

    const result = await executeInApp(resolveExpression, false, { timeoutMs: 30000 }, device);

    // Format output as tree
    if (result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.components) {
                // Summary mode
                const tonl = formatSummaryToTonl(parsed.components, parsed.totalElements);
                return { success: true, result: tonl };
            } else if (parsed.elements) {
                if (raw) {
                    return {
                        success: true,
                        result: result.result,
                        parsedElements: parsed.elements,
                        viewport: parsed.viewport,
                        offScreenBelow: Array.isArray(parsed.offScreenBelow) ? parsed.offScreenBelow : [],
                        offScreenAbove: Array.isArray(parsed.offScreenAbove) ? parsed.offScreenAbove : []
                    };
                }
                const tree = formatScreenLayoutTree(parsed.elements, extended, {
                    offScreenBelow: Array.isArray(parsed.offScreenBelow) ? parsed.offScreenBelow : [],
                    offScreenAbove: Array.isArray(parsed.offScreenAbove) ? parsed.offScreenAbove : []
                });
                return { success: true, result: tree };
            }
        } catch {
            // If parsing fails, return original result
        }
    }

    return result;
}

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
                    var t = collectText(child, d + 1, false);
                    if (t) parts.push(t);
                    child = child.sibling;
                }
                return parts.join(' ').trim();
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
                        // If name is generic (e.g. View, TouchableOpacity), scan children for a
                        // meaningful name like SvgChevronBack so icon-only buttons are identifiable.
                        if (GENERIC_COMPONENT.test(componentName)) {
                            var childName = findMeaningfulChildName(fiber);
                            if (childName) componentName = childName;
                        }
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

            walkPressables(roots[0].current, 0);

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

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000 }, device);
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
                    isInput: info.isInput
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
                pe.intent = humanize(pe.component);
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
                    var dx = tb.cx - pcx;
                    var dy = tb.cy - pcy;
                    var d = Math.sqrt(dx * dx + dy * dy);
                    if (d < bestDist && d <= NEARBY_RADIUS) {
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

    const result = await executeInApp(resolveExpression, false, { timeoutMs: 30000 }, device);

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
                const label = el.hasLabel
                    ? `"${el.text}"`
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

interface EnrichedElement {
    component: string;
    frame: { x: number; y: number; width: number; height: number };
    tapX: number;
    tapY: number;
    text?: string;
    identifiers?: Record<string, string>;
    parentIndex?: number;
    originalIndex?: number;
    depth?: number;
    path?: string;
}

/**
 * Format enriched elements as an indented tree with tap coordinates in pixels.
 * Same tree structure as get_screen_layout but with tap:(x,y) per node.
 */
function formatEnrichedLayoutTree(
    elements: EnrichedElement[],
    offScreen?: { offScreenBelow?: string[]; offScreenAbove?: string[] }
): string {
    const tree = formatLayoutTree(elements, (el, indent, isLeaf) => {
        const prefix = "  ".repeat(indent);
        const frame = `(${Math.round(el.frame.x)},${Math.round(el.frame.y)} ${Math.round(el.frame.width)}x${Math.round(el.frame.height)})`;
        const tap = ` tap:(${el.tapX},${el.tapY})`;
        const id = el.identifiers?.testID || el.identifiers?.accessibilityLabel || "";
        const idStr = id ? ` [${id}]` : "";
        const textStr = el.text && isLeaf ? ` "${el.text}"` : "";
        return `${prefix}${el.component} ${frame}${tap}${idStr}${textStr}`;
    });
    const suffix: string[] = [];
    if (offScreen?.offScreenAbove?.length) {
        suffix.push(formatOffScreenLine(offScreen.offScreenAbove, "above fold"));
    }
    if (offScreen?.offScreenBelow?.length) {
        suffix.push(formatOffScreenLine(offScreen.offScreenBelow, "below fold"));
    }
    return suffix.length > 0 ? `${tree}\n\n${suffix.join("\n")}` : tree;
}

/**
 * Enrich screen layout data with tap-ready pixel coordinates for bundling with screenshots.
 * Converts points/dp frame coordinates to pixels using the device pixel ratio,
 * computes center-point tapX/tapY for each element.
 *
 * @param pixelRatio - device pixel ratio (e.g., 3 for @3x iPhone)
 * @param screenshotScaleFactor - if the screenshot image was scaled down, this factor adjusts coordinates
 * @param device - optional target device name
 * @returns formatted tree string with pixel coordinates, or null if unavailable
 */
export async function enrichScreenshotWithLayout(
    pixelRatio: number,
    screenshotScaleFactor: number,
    device?: string,
    safeAreaTopPoints: number = 0
): Promise<string | null> {
    try {
        const result = await getScreenLayout({ extended: false, summary: false, device, raw: true });
        if (!result.success || !result.parsedElements || result.parsedElements.length === 0) return null;

        const elements: EnrichedElement[] = result.parsedElements.map((el: ScreenElement) => {
            const frame = el.frame || { x: 0, y: 0, width: 0, height: 0 };

            // React-native-screens modal/sheet presentations on iOS cause measureInWindow to return y
            // relative to the screen's content origin (below safe-area inset), not the window origin.
            // An element whose center y sits inside the safe-area band is physically impossible for a
            // visible interactive target — treat that as a sign of the shifted space and add the inset.
            const centerXPoints = frame.x + frame.width / 2;
            let centerYPoints = frame.y + frame.height / 2;
            let yPoints = frame.y;
            if (safeAreaTopPoints > 0 && centerYPoints < safeAreaTopPoints) {
                centerYPoints += safeAreaTopPoints;
                yPoints += safeAreaTopPoints;
            }

            const tapX = Math.round((centerXPoints * pixelRatio) / screenshotScaleFactor);
            const tapY = Math.round((centerYPoints * pixelRatio) / screenshotScaleFactor);

            const pixelFrame = {
                x: Math.round((frame.x * pixelRatio) / screenshotScaleFactor),
                y: Math.round((yPoints * pixelRatio) / screenshotScaleFactor),
                width: Math.round((frame.width * pixelRatio) / screenshotScaleFactor),
                height: Math.round((frame.height * pixelRatio) / screenshotScaleFactor),
            };

            return {
                component: el.component,
                frame: pixelFrame,
                tapX,
                tapY,
                text: el.text,
                identifiers: el.identifiers,
                parentIndex: el.parentIndex,
                originalIndex: el.originalIndex,
                depth: el.depth,
                path: el.path,
            };
        });

        return formatEnrichedLayoutTree(elements, {
            offScreenBelow: result.offScreenBelow,
            offScreenAbove: result.offScreenAbove,
        });
    } catch {
        return null; // Non-fatal: screenshot works without layout
    }
}

/**
 * Inspect a specific component by name, returning its props, state, and layout.
 */
export async function inspectComponent(
    componentName: string,
    options: {
        index?: number;
        includeState?: boolean;
        includeChildren?: boolean;
        childrenDepth?: number;
        shortPath?: boolean;
        simplifyHooks?: boolean;
        device?: string;
    } = {}
): Promise<ExecutionResult> {
    const {
        index = 0,
        includeState = true,
        includeChildren = false,
        childrenDepth = 1,
        shortPath = true,
        simplifyHooks = true,
        device
    } = options;
    const escapedName = componentName.replace(/'/g, "\\'");

    const expression = `
        (function() {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found.' };

            let roots = [];
            if (hook.getFiberRoots) {
                roots = [...(hook.getFiberRoots(1) || [])];
            }
            if (roots.length === 0 && hook.renderers) {
                for (const [id] of hook.renderers) {
                    const r = hook.getFiberRoots ? [...(hook.getFiberRoots(id) || [])] : [];
                    if (r.length > 0) { roots = r; break; }
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found.' };

            const targetName = '${escapedName}';
            const targetIndex = ${index};
            const includeState = ${includeState};
            const includeChildren = ${includeChildren};
            const childrenDepth = ${childrenDepth};
            const shortPath = ${shortPath};
            const simplifyHooks = ${simplifyHooks};
            const pathSegments = 3;

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            function formatPath(pathArray) {
                if (!shortPath || pathArray.length <= pathSegments) {
                    return pathArray.join(' > ');
                }
                return '... > ' + pathArray.slice(-pathSegments).join(' > ');
            }

            function extractStyles(style) {
                try {
                    if (!style) return null;
                    const merged = Array.isArray(style)
                        ? Object.assign({}, ...style.filter(Boolean).map(s => {
                            try { return typeof s === 'object' ? s : {}; }
                            catch { return {}; }
                        }))
                        : (typeof style === 'object' ? style : {});
                    return Object.keys(merged).length > 0 ? merged : null;
                } catch { return { _note: '[Contains animated styles]' }; }
            }

            function serializeValue(val, depth = 0) {
                if (depth > 3) return '[Max depth]';
                if (val === null) return null;
                if (val === undefined) return undefined;
                if (typeof val === 'function') return '[Function]';
                if (typeof val !== 'object') return val;
                if (Array.isArray(val)) {
                    if (val.length > 10) return '[Array(' + val.length + ')]';
                    return val.map(v => serializeValue(v, depth + 1));
                }
                // Object
                const keys = Object.keys(val);
                if (keys.length > 20) return '[Object(' + keys.length + ' keys)]';
                const result = {};
                for (const k of keys) {
                    try {
                        result[k] = serializeValue(val[k], depth + 1);
                    } catch {
                        result[k] = '[Animated Value]';
                    }
                }
                return result;
            }

            function getChildTree(fiber, depth) {
                if (!fiber || depth <= 0) return null;
                const children = [];
                let child = fiber?.child;
                while (child && children.length < 30) {
                    const name = getComponentName(child);
                    if (name) {
                        if (depth === 1) {
                            // Just names for depth 1
                            children.push(name);
                        } else {
                            // Tree structure for depth > 1
                            const nestedChildren = getChildTree(child, depth - 1);
                            children.push(nestedChildren ? { component: name, children: nestedChildren } : name);
                        }
                    }
                    child = child.sibling;
                }
                return children.length > 0 ? children : null;
            }

            const matches = [];

            function findComponent(fiber, path) {
                if (!fiber) return;

                const name = getComponentName(fiber);
                if (name === targetName) {
                    matches.push({ fiber, path: [...path, name] });
                }

                let child = fiber.child;
                while (child) {
                    const childName = getComponentName(child);
                    findComponent(child, childName ? [...path, childName] : path);
                    child = child.sibling;
                }
            }

            findComponent(roots[0].current, []);

            if (matches.length === 0) {
                return { error: 'Component "' + targetName + '" not found in the component tree.' };
            }

            if (targetIndex >= matches.length) {
                return { error: 'Component "' + targetName + '" found ' + matches.length + ' times, but index ' + targetIndex + ' requested.' };
            }

            const { fiber, path } = matches[targetIndex];

            const result = {
                component: targetName,
                path: formatPath(path),
                instancesFound: matches.length,
                instanceIndex: targetIndex
            };

            // Props (excluding children)
            if (fiber.memoizedProps) {
                const props = {};
                for (const key of Object.keys(fiber.memoizedProps)) {
                    if (key === 'children') continue;
                    try {
                        props[key] = serializeValue(fiber.memoizedProps[key]);
                    } catch {
                        props[key] = '[Animated Value]';
                    }
                }
                result.props = props;
            }

            // Style separately for clarity
            try {
                if (fiber.memoizedProps?.style) {
                    result.style = extractStyles(fiber.memoizedProps.style);
                }
            } catch {
                result.style = { _note: '[Contains animated styles]' };
            }

            // State (for hooks, this is a linked list)
            if (includeState && fiber.memoizedState) {
                // Simplified hook value serialization
                function serializeHookValue(val, depth = 0) {
                    try {
                        if (depth > 2) return '[...]';
                        if (val === null || val === undefined) return val;
                        if (typeof val === 'function') return '[Function]';
                        if (typeof val !== 'object') return val;
                        // Skip React internal structures (effects, refs with destroy/create)
                        if (val.create && val.destroy !== undefined) return '[Effect]';
                        if (val.inst && val.deps) return '[Effect]';
                        if (val.current !== undefined && Object.keys(val).length === 1) {
                            // Ref object - just show current value
                            return { current: serializeHookValue(val.current, depth + 1) };
                        }
                        if (Array.isArray(val)) {
                            if (val.length > 5) return '[Array(' + val.length + ')]';
                            return val.slice(0, 5).map(v => serializeHookValue(v, depth + 1));
                        }
                        const keys = Object.keys(val);
                        if (keys.length > 10) return '[Object(' + keys.length + ' keys)]';
                        const result = {};
                        for (const k of keys.slice(0, 10)) {
                            try {
                                result[k] = serializeHookValue(val[k], depth + 1);
                            } catch {
                                result[k] = '[Animated Value]';
                            }
                        }
                        return result;
                    } catch { return '[Animated Value]'; }
                }

                // For function components with hooks
                const states = [];
                let state = fiber.memoizedState;
                let hookIndex = 0;
                while (state && hookIndex < 20) {
                    if (state.memoizedState !== undefined) {
                        const hookVal = simplifyHooks
                            ? serializeHookValue(state.memoizedState)
                            : serializeValue(state.memoizedState);
                        // Skip effect hooks in simplified mode
                        if (!simplifyHooks || (hookVal !== '[Effect]' && hookVal !== undefined)) {
                            states.push({
                                hookIndex,
                                value: hookVal
                            });
                        }
                    }
                    state = state.next;
                    hookIndex++;
                }
                if (states.length > 0) result.hooks = states;

                // For class components, memoizedState is the state object directly
                if (states.length === 0 && typeof fiber.memoizedState === 'object') {
                    result.state = serializeValue(fiber.memoizedState);
                }
            }

            // Children tree (depth controlled by childrenDepth)
            if (includeChildren) {
                result.children = getChildTree(fiber, childrenDepth);
            }

            return result;
        })()
    `;

    return executeInApp(expression, false, {}, device);
}

/**
 * Find all components matching a name pattern and return summary info.
 */
export async function findComponents(
    pattern: string,
    options: {
        maxResults?: number;
        includeLayout?: boolean;
        shortPath?: boolean;
        summary?: boolean;
        format?: "json" | "tonl";
        device?: string;
    } = {}
): Promise<ExecutionResult> {
    const { maxResults = 20, includeLayout = false, shortPath = true, summary = false, format = "tonl", device } = options;
    const escapedPattern = pattern.replace(/'/g, "\\'").replace(/\\/g, "\\\\");

    const expression = `
        (function() {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found.' };

            let roots = [];
            if (hook.getFiberRoots) {
                roots = [...(hook.getFiberRoots(1) || [])];
            }
            if (roots.length === 0 && hook.renderers) {
                for (const [id] of hook.renderers) {
                    const r = hook.getFiberRoots ? [...(hook.getFiberRoots(id) || [])] : [];
                    if (r.length > 0) { roots = r; break; }
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found.' };

            const pattern = '${escapedPattern}';
            const regex = new RegExp(pattern, 'i');
            const maxResults = ${maxResults};
            const includeLayout = ${includeLayout};
            const shortPath = ${shortPath};
            const summaryMode = ${summary};
            const pathSegments = 3;

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            function formatPath(pathArray) {
                if (!shortPath || pathArray.length <= pathSegments) {
                    return pathArray.join(' > ');
                }
                return '... > ' + pathArray.slice(-pathSegments).join(' > ');
            }

            function extractLayoutStyles(style) {
                try {
                    if (!style) return null;
                    const merged = Array.isArray(style)
                        ? Object.assign({}, ...style.filter(Boolean).map(s => {
                            try { return typeof s === 'object' ? s : {}; }
                            catch { return {}; }
                        }))
                        : (typeof style === 'object' ? style : {});

                    const layout = {};
                    const keys = ['padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
                        'paddingHorizontal', 'paddingVertical', 'margin', 'marginTop', 'marginBottom',
                        'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical',
                        'width', 'height', 'flex', 'flexDirection', 'justifyContent', 'alignItems'];
                    for (const k of keys) {
                        if (merged[k] !== undefined) layout[k] = merged[k];
                    }
                    return Object.keys(layout).length > 0 ? layout : null;
                } catch { return null; }
            }

            const results = [];

            function search(fiber, path, depth) {
                if (!fiber || results.length >= maxResults) return;

                try {
                    var name = getComponentName(fiber);
                    if (name && regex.test(name)) {
                        var entry = {
                            component: name,
                            path: formatPath(path),
                            depth
                        };

                        if (fiber.memoizedProps && fiber.memoizedProps.testID) entry.testID = fiber.memoizedProps.testID;
                        if (fiber.key) entry.key = fiber.key;

                        if (includeLayout && fiber.memoizedProps && fiber.memoizedProps.style) {
                            try {
                                var layout = extractLayoutStyles(fiber.memoizedProps.style);
                                if (layout) entry.layout = layout;
                            } catch(e) {}
                        }

                        results.push(entry);
                    }

                    var child = fiber.child;
                    while (child && results.length < maxResults) {
                        var childName = getComponentName(child);
                        search(child, childName ? path.concat([childName]) : path, depth + 1);
                        child = child.sibling;
                    }
                } catch(e) {
                    try {
                        var child = fiber.child;
                        while (child && results.length < maxResults) {
                            search(child, path, depth + 1);
                            child = child.sibling;
                        }
                    } catch(e2) {}
                }
            }

            search(roots[0].current, [], 0);

            if (summaryMode) {
                const counts = {};
                for (const r of results) {
                    counts[r.component] = (counts[r.component] || 0) + 1;
                }
                const sorted = Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => ({ component: name, count }));
                return {
                    pattern,
                    totalMatches: results.length,
                    uniqueComponents: sorted.length,
                    components: sorted
                };
            }

            return {
                pattern,
                found: results.length,
                components: results
            };
        })()
    `;

    const result = await executeInApp(expression, false, {}, device);

    if (format === "tonl" && result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.components) {
                if (parsed.totalMatches !== undefined) {
                    const tonl = formatSummaryToTonl(parsed.components, parsed.totalMatches);
                    return { success: true, result: `pattern: ${parsed.pattern}\n${tonl}` };
                } else {
                    const tonl = formatFoundComponentsToTonl(parsed.components);
                    return { success: true, result: `pattern: ${parsed.pattern}\nfound: ${parsed.found}\n${tonl}` };
                }
            }
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

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000 }, options.device);
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

            // Filter visible and match
            var matches = [];
            for (var i = 0; i < measurements.length; i++) {
                var m = measurements[i];
                if (!m) continue;

                // Visibility filter: positive dimensions, within viewport
                if (m.width <= 0 || m.height <= 0) continue;
                if (m.x + m.width < 0 || m.y + m.height < 0) continue;
                if (m.x > viewportW || m.y > viewportH) continue;

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

                if (matched) {
                    matches.push({
                        name: info.name,
                        text: info.text,
                        testID: info.testID,
                        path: info.path,
                        isInput: info.isInput,
                        x: Math.round(m.x + m.width / 2),
                        y: Math.round(m.y + m.height / 2)
                    });
                }
            }

            if (matches.length === 0) {
                var criteria = [];
                if (searchText !== null) criteria.push('text="' + searchText + '"');
                if (searchTestID !== null) criteria.push('testID="' + searchTestID + '"');
                if (searchComponent !== null) criteria.push('component="' + searchComponent + '"');
                return { error: 'No visible pressable or focusable elements found matching: ' + criteria.join(', ') };
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

    return executeInApp(resolveExpression, false, { timeoutMs: 10000 }, options.device);
}

// ============================================================================
// Coordinate-Based Element Inspection (via DevTools Inspector API)
// ============================================================================

/**
 * Toggle the Element Inspector via DevSettings native module.
 * This enables the inspector overlay programmatically.
 */
export async function toggleElementInspector(device?: string): Promise<ExecutionResult> {
    const expression = `
        (function() {
            const ds = globalThis.nativeModuleProxy?.DevSettings;
            if (!ds) return { error: 'DevSettings not available' };

            const proto = Object.getPrototypeOf(ds);
            if (!proto || typeof proto.toggleElementInspector !== 'function') {
                return { error: 'toggleElementInspector not found' };
            }

            try {
                proto.toggleElementInspector.call(ds);
                return { success: true, message: 'Element Inspector toggled' };
            } catch (e) {
                return { error: 'Failed to toggle: ' + e.message };
            }
        })()
    `;

    return executeInApp(expression, false, {}, device);
}

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

    const result = await executeInApp(expression, false, {}, device);
    if (result.success && result.result) {
        return result.result === "true";
    }
    return false;
}

/**
 * Get the currently selected element from the Element Inspector overlay.
 * This reads the InspectorPanel component's props to get the hierarchy, frame, and style.
 * Requires the Element Inspector to be enabled and an element to be selected.
 */
export async function getInspectorSelection(device?: string): Promise<ExecutionResult> {
    const expression = `
        (function() {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not available.' };

            // Find fiber roots
            let roots = [...(hook.getFiberRoots?.(1) || [])];
            if (roots.length === 0) {
                for (const [id] of (hook.renderers || [])) {
                    roots = [...(hook.getFiberRoots?.(id) || [])];
                    if (roots.length > 0) break;
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found.' };

            // Find all InspectorPanel instances (apps with modals may have multiple)
            function findAllPanels(fiber, targetName, depth, results) {
                if (!fiber || depth > 5000) return;
                const name = fiber.type?.displayName || fiber.type?.name;
                if (name === targetName) results.push(fiber);
                let child = fiber.child;
                while (child) {
                    findAllPanels(child, targetName, depth + 1, results);
                    child = child.sibling;
                }
            }

            const panels = [];
            findAllPanels(roots[0].current, 'InspectorPanel', 0, panels);
            if (panels.length === 0) {
                return {
                    error: 'Element Inspector is not active.',
                    hint: 'Use toggle_element_inspector to enable the inspector, then tap an element to select it.'
                };
            }

            // Prefer the panel that has an active selection
            const panelFiber = panels.find(p => p.memoizedProps.hierarchy?.length > 0) || panels[0];
            const props = panelFiber.memoizedProps;
            if (!props.hierarchy || props.hierarchy.length === 0) {
                return {
                    error: 'No element selected.',
                    hint: 'Tap on an element in the app to select it for inspection.'
                };
            }

            // Build the path from hierarchy
            const path = props.hierarchy.map(h => h.name).join(' > ');
            const element = props.hierarchy[props.hierarchy.length - 1]?.name || 'Unknown';

            // Extract style info
            let style = {};
            if (props.inspected?.style) {
                const styles = Array.isArray(props.inspected.style)
                    ? props.inspected.style
                    : [props.inspected.style];
                for (const s of styles) {
                    if (s && typeof s === 'object') {
                        Object.assign(style, s);
                    }
                }
            }

            return {
                element,
                path,
                frame: props.inspected?.frame || null,
                style: Object.keys(style).length > 0 ? style : null,
                selection: props.selection,
                hierarchyLength: props.hierarchy.length
            };
        })()
    `;

    return executeInApp(expression, false, {}, device);
}

/**
 * Resolve the component at (x, y) using RN's built-in Element Inspector.
 *
 * Strategy: programmatically toggle the inspector overlay on (if needed),
 * then call InspectorOverlay.props.onTouchPoint(x, y) directly — bypassing
 * the broken adb-tap → PanResponder route on Bridgeless / new-arch RN.
 * This populates InspectorPanel with RN's full curated hierarchy, the
 * inspected element's frame, and per-component style data (margin, padding,
 * border, layout) — exactly what the on-device overlay shows.
 *
 * Returns the rich hierarchy with style merged from each entry's
 * getInspectorData(...).props.style, plus the inspected frame and style.
 *
 * Auto-hides the overlay after capture so subsequent screenshots stay clean.
 */
export async function getInspectorSelectionAtPoint(
    x: number,
    y: number,
    device?: string
): Promise<ExecutionResult> {
    // Step 1: ensure the inspector overlay is mounted (toggle on if currently off).
    const setupExpression = `
        (function() {
            var ds = globalThis.nativeModuleProxy && globalThis.nativeModuleProxy.DevSettings;
            if (!ds) return { error: 'DevSettings native module not available.' };
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not available. Make sure you are running a development build.' };

            function findOverlays() {
                var roots = [];
                if (hook.renderers) {
                    for (var entry of hook.renderers) {
                        try { roots = roots.concat(Array.from(hook.getFiberRoots(entry[0]) || [])); } catch(e) {}
                    }
                }
                var overlays = [];
                function walk(f, d) {
                    if (!f || d > 800) return;
                    if (f.type && typeof f.type !== 'string' &&
                        (f.type.displayName || f.type.name) === 'InspectorOverlay') {
                        overlays.push(f);
                    }
                    var c = f.child;
                    while (c) { walk(c, d + 1); c = c.sibling; }
                }
                for (var r of roots) { walk(r.current, 0); }
                return overlays;
            }

            var overlays = findOverlays();
            // Two overlays expected when active: one per fiber root (LogBox + app).
            var wasActive = overlays.length >= 2;
            if (!wasActive) {
                var proto = Object.getPrototypeOf(ds);
                if (typeof proto.toggleElementInspector !== 'function') {
                    return { error: 'toggleElementInspector not found on DevSettings.' };
                }
                proto.toggleElementInspector.call(ds);
            }
            return { wasActive: wasActive };
        })()
    `;

    const setup = await executeInApp(setupExpression, false, {}, device);
    if (!setup.success) return setup;
    try {
        const parsed = JSON.parse(setup.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
    } catch {
        /* ignore */
    }

    // Allow the inspector overlay to mount.
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Step 2: locate the app InspectorOverlay (skip LogBox at index 0) and dispatch onTouchPoint.
    const tapExpression = `
        (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            var roots = [];
            for (var entry of hook.renderers) {
                try { roots = roots.concat(Array.from(hook.getFiberRoots(entry[0]) || [])); } catch(e) {}
            }
            var overlays = [];
            function walk(f, d) {
                if (!f || d > 800) return;
                if (f.type && typeof f.type !== 'string' &&
                    (f.type.displayName || f.type.name) === 'InspectorOverlay') {
                    overlays.push(f);
                }
                var c = f.child;
                while (c) { walk(c, d + 1); c = c.sibling; }
            }
            for (var r of roots) { walk(r.current, 0); }

            // The LogBox renderer's overlay is mounted first; the app overlay is the last one.
            var overlay = overlays[overlays.length - 1];
            if (!overlay || !overlay.memoizedProps || typeof overlay.memoizedProps.onTouchPoint !== 'function') {
                return { error: 'InspectorOverlay.onTouchPoint unavailable. Inspector may not be mounted.' };
            }
            try {
                overlay.memoizedProps.onTouchPoint(${x}, ${y});
            } catch (e) {
                return { error: 'onTouchPoint failed: ' + (e && e.message || String(e)) };
            }
            return { ok: true };
        })()
    `;

    const tap = await executeInApp(tapExpression, false, {}, device);
    if (!tap.success) return tap;
    try {
        const parsed = JSON.parse(tap.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
    } catch {
        /* ignore */
    }

    // Allow setState/render to propagate before reading panel props.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Step 3: read the populated InspectorPanel and shape the response.
    const readExpression = `
        (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            var roots = [];
            for (var entry of hook.renderers) {
                try { roots = roots.concat(Array.from(hook.getFiberRoots(entry[0]) || [])); } catch(e) {}
            }
            var panels = [];
            function walk(f, d) {
                if (!f || d > 800) return;
                if (f.type && typeof f.type !== 'string' &&
                    (f.type.displayName || f.type.name) === 'InspectorPanel') {
                    panels.push(f);
                }
                var c = f.child;
                while (c) { walk(c, d + 1); c = c.sibling; }
            }
            for (var r of roots) { walk(r.current, 0); }

            var withSel = panels.filter(function(p) {
                return p.memoizedProps && p.memoizedProps.hierarchy && p.memoizedProps.hierarchy.length > 0;
            });
            if (withSel.length === 0) {
                return { error: 'Inspector did not select an element at (${x}, ${y}). Coordinates may be outside the app bounds.' };
            }
            var props = withSel[withSel.length - 1].memoizedProps;

            function flattenStyle(raw) {
                if (!raw) return null;
                var arr = Array.isArray(raw) ? raw : [raw];
                var merged = {};
                for (var i = 0; i < arr.length; i++) {
                    var v = arr[i];
                    if (v && typeof v === 'object') {
                        var keys = Object.keys(v);
                        for (var k = 0; k < keys.length; k++) merged[keys[k]] = v[keys[k]];
                    }
                }
                return Object.keys(merged).length > 0 ? merged : null;
            }

            var idFn = function(x) { return x; };
            // Build hierarchy with style + source per entry; dedupe consecutive duplicates.
            var hierarchy = [];
            var prevName = null;
            for (var i = 0; i < props.hierarchy.length; i++) {
                var h = props.hierarchy[i];
                var name = h.name;
                if (!name || name === prevName) continue;
                prevName = name;
                var data = h.getInspectorData ? h.getInspectorData(idFn) : null;
                var style = data && data.props ? flattenStyle(data.props.style) : null;
                var entry = { name: name };
                if (style) entry.style = style;
                if (data && data.source && data.source.fileName) {
                    entry.source = data.source.fileName + (data.source.lineNumber ? (':' + data.source.lineNumber) : '');
                }
                hierarchy.push(entry);
            }

            var element = hierarchy.length > 0 ? hierarchy[hierarchy.length - 1].name : 'Unknown';
            var path = hierarchy.map(function(e) { return e.name; }).join(' > ') || element;

            return {
                element: element,
                path: path,
                frame: props.inspected ? props.inspected.frame : null,
                style: props.inspected ? flattenStyle(props.inspected.style) : null,
                hierarchy: hierarchy,
                selection: props.selection
            };
        })()
    `;

    const readResult = await executeInApp(readExpression, false, {}, device);

    // Step 4: hide the overlay so it doesn't pollute subsequent screenshots.
    // We always hide after a successful capture — agents don't manually toggle.
    const teardownExpression = `
        (function() {
            var ds = globalThis.nativeModuleProxy && globalThis.nativeModuleProxy.DevSettings;
            if (!ds) return { skipped: true };
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { skipped: true };
            var roots = [];
            for (var entry of hook.renderers) {
                try { roots = roots.concat(Array.from(hook.getFiberRoots(entry[0]) || [])); } catch(e) {}
            }
            var overlays = 0;
            function walk(f, d) {
                if (!f || d > 800) return;
                if (f.type && typeof f.type !== 'string' &&
                    (f.type.displayName || f.type.name) === 'InspectorOverlay') overlays++;
                var c = f.child;
                while (c) { walk(c, d + 1); c = c.sibling; }
            }
            for (var r of roots) { walk(r.current, 0); }
            if (overlays >= 2) {
                try { Object.getPrototypeOf(ds).toggleElementInspector.call(ds); } catch(e) {}
            }
            return { ok: true };
        })()
    `;
    try {
        await executeInApp(teardownExpression, false, {}, device);
    } catch {
        /* best-effort hide; don't fail the call */
    }

    return readResult;
}

/**
 * Inspect the React component at a specific (x, y) coordinate.
 *
 * Works on both Paper and Fabric (New Architecture). Uses a two-step approach
 * because measureInWindow callbacks fire in a future native event loop tick
 * (not microtasks), so awaitPromise cannot be used to collect them:
 *
 * Step 1 — dispatch: walk the fiber tree, call measureInWindow on each host
 *   component, store fiber refs and results in app globals.
 * Step 2 — resolve (after 300ms): read the globals, hit-test against target
 *   coordinates, return the innermost matching React component.
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

    // --- Step 1: walk fiber tree + dispatch measureInWindow calls ---
    const dispatchExpression = `
        (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not available. Make sure you are running a development build.' };

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
            if (roots.length === 0) return { error: 'No fiber roots found. The app may not have rendered yet.' };

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

            if (hostFibers.length === 0) return { error: 'No measurable host components found. App may not be fully rendered.' };

            globalThis.__inspectFibers = hostFibers;
            globalThis.__inspectMeasurements = new Array(hostFibers.length).fill(null);

            hostFibers.forEach(function(fiber, i) {
                try {
                    getMeasurable(fiber).measureInWindow(function(fx, fy, fw, fh) {
                        globalThis.__inspectMeasurements[i] = { x: fx, y: fy, width: fw, height: fh };
                    });
                } catch(e) {}
            });

            return { count: hostFibers.length };
        })()
    `;

    const dispatchResult = await executeInApp(dispatchExpression, false, {}, device);
    if (!dispatchResult.success) return dispatchResult;

    try {
        const parsed = JSON.parse(dispatchResult.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
    } catch {
        /* ignore parse errors */
    }

    // Wait for native measureInWindow callbacks to fire
    await delay(300);

    // --- Step 2: read measurements, hit-test, return result ---
    const resolveExpression = `
        (function() {
            var fibers = globalThis.__inspectFibers;
            var measurements = globalThis.__inspectMeasurements;
            globalThis.__inspectFibers = null;
            globalThis.__inspectMeasurements = null;

            if (!fibers || !measurements) return { error: 'No measurement data available. Run inspect_at_point again.' };

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
        })()
    `;

    return executeInApp(resolveExpression, false, {}, device);
}
