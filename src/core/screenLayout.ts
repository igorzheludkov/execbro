import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";

export interface ComponentSummary {
    component: string;
    count: number;
}

export function formatSummaryToTonl(components: ComponentSummary[], total: number): string {
    const lines: string[] = [`#summary total=${total}`];
    for (const c of components) {
        lines.push(`${c.component}:${c.count}`);
    }
    return lines.join("\n");
}

// ============================================================================
// Screen Layout (visible component tree with positions)
// ============================================================================

export interface ScreenElement {
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
    renderLine: (el: T, indent: number, isLeaf: boolean, parent: T | null) => string
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

    function printNode(idx: number, indent: number, parent: T | null) {
        const isLeaf = !children.has(idx);
        lines.push(renderLine(elements[idx], indent, isLeaf, parent));
        const kids = children.get(idx);
        if (kids) {
            for (const kid of kids) {
                printNode(kid, indent + 1, elements[idx]);
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
            printNode(roots[ri], 0, null);
        }
    } else {
        for (const root of roots) {
            printNode(root, 0, null);
        }
    }

    return lines.join("\n");
}

/**
 * Compute per-side overflow of a child frame relative to its parent.
 * Returns null if neither has a frame, or overflow is within 1pt of rounding noise.
 */
function computeOverflow(
    child: LayoutNode,
    parent: LayoutNode
): { sides: { left?: number; right?: number; top?: number; bottom?: number }; max: number; dominantSide: string } | null {
    if (!child.frame || !parent.frame) return null;
    const cf = child.frame, pf = parent.frame;
    const sides: { left?: number; right?: number; top?: number; bottom?: number } = {};
    const dLeft = pf.x - cf.x;
    const dRight = (cf.x + cf.width) - (pf.x + pf.width);
    const dTop = pf.y - cf.y;
    const dBottom = (cf.y + cf.height) - (pf.y + pf.height);
    if (dLeft > 1) sides.left = dLeft;
    if (dRight > 1) sides.right = dRight;
    if (dTop > 1) sides.top = dTop;
    if (dBottom > 1) sides.bottom = dBottom;
    const entries = Object.entries(sides) as [string, number][];
    if (entries.length === 0) return null;
    let max = 0, dominantSide = "";
    for (const [k, v] of entries) {
        if (v > max) { max = v; dominantSide = k; }
    }
    return { sides, max, dominantSide };
}

export function formatScreenLayoutTree(
    elements: ScreenElement[],
    extended: boolean = false,
    offScreen?: { offScreenBelow?: string[]; offScreenAbove?: string[] }
): string {
    const overflows: { child: string; parent: string; max: number; dominantSide: string }[] = [];
    const tree = formatLayoutTree(elements, (el, indent, isLeaf, parent) => {
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
        let overflowStr = "";
        if (parent) {
            const ovf = computeOverflow(el, parent);
            if (ovf) {
                overflowStr = ` ⚠ overflows parent by ${Math.round(ovf.max)}pt (${ovf.dominantSide})`;
                overflows.push({ child: el.component, parent: parent.component, max: ovf.max, dominantSide: ovf.dominantSide });
            }
        }
        return `${prefix}${el.component}${frame}${idStr}${textStr}${layoutStr}${overflowStr}`;
    });
    const suffix: string[] = [];
    if (overflows.length > 0) {
        const sorted = overflows.slice().sort((a, b) => b.max - a.max);
        const lines = [`[overflows] ${sorted.length} node${sorted.length === 1 ? "" : "s"} extend beyond parent (largest first):`];
        for (const o of sorted) {
            lines.push(`  ${o.child} overflows ${o.parent} by ${Math.round(o.max)}pt (${o.dominantSide})`);
        }
        suffix.push(lines.join("\n"));
    }
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

export async function getScreenLayout(
    options: {
        extended?: boolean;
        summary?: boolean;
        device?: string;
        raw?: boolean;
        timeoutMs?: number;
    } = {}
): Promise<ExecutionResult & {
    parsedElements?: ScreenElement[];
    viewport?: { width: number; height: number };
    offScreenBelow?: string[];
    offScreenAbove?: string[];
}> {
    const { extended = false, summary = false, device, raw = false, timeoutMs } = options;
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

    let dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: timeoutMs ?? 30000, originatingToolName: "get_screen_layout" }, device);
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
        dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: timeoutMs ?? 30000, originatingToolName: "get_screen_layout" }, device);
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

    const result = await executeInApp(resolveExpression, false, { timeoutMs: timeoutMs ?? 30000, originatingToolName: "get_screen_layout" }, device);

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
    const tree = formatLayoutTree(elements, (el, indent, isLeaf, _parent) => {
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
