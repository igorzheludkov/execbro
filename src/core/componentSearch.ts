import type { ExecutionResult } from "./types.js";
import { executeInApp } from "./jsExecute.js";
import { formatSummaryToTonl } from "./screenLayout.js";

// ============================================================================
// Component Search (findComponents, inspectComponent)
// ============================================================================

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
        includeStyle?: boolean;
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
        includeStyle = false,
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
            const includeStyle = ${includeStyle};
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

            const resolveRNStyle = (hook && hook.resolveRNStyle) || null;

            function flattenStyleProp(style) {
                if (style == null || style === false || style === true) return null;
                if (typeof style === 'number') {
                    if (resolveRNStyle) {
                        try {
                            const resolved = resolveRNStyle(style);
                            return resolved ? flattenStyleProp(resolved) : null;
                        } catch { return null; }
                    }
                    return null;
                }
                if (Array.isArray(style)) {
                    const out = {};
                    for (const item of style) {
                        const flat = flattenStyleProp(item);
                        if (flat && typeof flat === 'object') Object.assign(out, flat);
                    }
                    return Object.keys(out).length ? out : null;
                }
                if (typeof style === 'object') return style;
                return null;
            }

            function sanitizeStyleObject(s) {
                if (!s || typeof s !== 'object') return null;
                const out = {};
                for (const k of Object.keys(s)) {
                    const v = s[k];
                    if (v === undefined) continue;
                    if (v === null) { out[k] = null; continue; }
                    const t = typeof v;
                    if (t === 'function') { out[k] = '[Function]'; continue; }
                    if (t === 'object') {
                        try { JSON.stringify(v); out[k] = v; }
                        catch { out[k] = String(v); }
                        continue;
                    }
                    out[k] = v;
                }
                return Object.keys(out).length ? out : null;
            }

            function getResolvedStyle(fiber) {
                try {
                    const raw = fiber && fiber.memoizedProps && fiber.memoizedProps.style;
                    if (raw == null) return null;
                    return sanitizeStyleObject(flattenStyleProp(raw));
                } catch { return null; }
            }

            function getChildTree(fiber, depth) {
                if (!fiber || depth <= 0) return null;
                const children = [];
                let child = fiber?.child;
                while (child && children.length < 30) {
                    const name = getComponentName(child);
                    if (name) {
                        const style = includeStyle ? getResolvedStyle(child) : null;
                        if (depth === 1) {
                            if (includeStyle) {
                                const entry = { component: name };
                                if (style) entry.style = style;
                                children.push(entry);
                            } else {
                                children.push(name);
                            }
                        } else {
                            const nestedChildren = getChildTree(child, depth - 1);
                            if (includeStyle) {
                                const entry = { component: name };
                                if (style) entry.style = style;
                                if (nestedChildren) entry.children = nestedChildren;
                                children.push(entry);
                            } else {
                                children.push(nestedChildren ? { component: name, children: nestedChildren } : name);
                            }
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
