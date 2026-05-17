export * from "./jsExecute.js";
export * from "./debugGlobals.js";
export * from "./componentTree.js";
export * from "./screenLayout.js";
export * from "./pressables.js";

import WebSocket from "ws";
import { ExecutionResult, ExecuteOptions } from "./types.js";
import { pendingExecutions, getNextMessageId, connectedApps } from "./state.js";
import { getFirstConnectedApp, getConnectedAppByDevice, getConnectedAppBySimulatorUdid, getConnectedAppByAndroidDeviceId, connectToDevice, clearReconnectionSuppression, purgeStaleConnectionsForPorts } from "./connection.js";
import { fetchDevices, selectMainDevice, filterDebuggableDevices, scanMetroPorts } from "./metro.js";
import type { DeviceInfo } from "./types.js";
import { DEFAULT_RECONNECTION_CONFIG, cancelReconnectionTimer } from "./connectionState.js";
import { validateAndPreprocessExpression, executeInApp, delay } from "./jsExecute.js";
import { formatSummaryToTonl } from "./screenLayout.js";




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
