import type { ComponentStack, SelectionFrame } from "./selectionBuffer.js";
import { parseStackString, symbolicateFrames } from "./symbolicate.js";
import type { StackFrame } from "./symbolicate.js";

export interface ProbeResult {
    active: boolean;
    selected: boolean;
    changed: boolean;
    element?: string;
    path?: string;
    hierarchy?: string[];
    frame?: SelectionFrame | null;
    style?: Record<string, unknown> | null;
}

export interface HarvestResult {
    stacks: ComponentStack[];
    error?: string;
}

/** Shared fiber-root lookup. Hermes-safe: var + function only. */
const ROOTS_SNIPPET = `
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var roots = [];
    if (hook && hook.getFiberRoots) {
        if (hook.renderers) {
            for (var entry of hook.renderers) {
                try { roots = roots.concat(Array.from(hook.getFiberRoots(entry[0]) || [])); } catch (e) {}
            }
        }
        if (roots.length === 0) {
            try { roots = Array.from(hook.getFiberRoots(1) || []); } catch (e) {}
        }
    }
`;

/**
 * Cheap per-tick probe. Deliberately does NO measurement — it runs every
 * 500-2000ms and must stay inexpensive. Reports whether RN's inspector is
 * mounted and whether its selection changed since the previous tick.
 */
export function buildSelectionProbeExpression(): string {
    return `
        (function() {
            ${ROOTS_SNIPPET}
            if (roots.length === 0) return { active: false, selected: false, changed: false };

            var panels = [];
            function walk(fiber, depth) {
                if (!fiber || depth > 3000) return;
                if (fiber.type && typeof fiber.type !== 'string' &&
                    (fiber.type.displayName || fiber.type.name) === 'InspectorPanel') {
                    panels.push(fiber);
                }
                var child = fiber.child;
                while (child) { walk(child, depth + 1); child = child.sibling; }
            }
            for (var r = 0; r < roots.length; r++) { walk(roots[r].current, 0); }

            if (panels.length === 0) {
                globalThis.__execbro_lastInspected = undefined;
                return { active: false, selected: false, changed: false };
            }

            var panel = null;
            for (var p = 0; p < panels.length; p++) {
                var h = panels[p].memoizedProps && panels[p].memoizedProps.hierarchy;
                if (h && h.length > 0) { panel = panels[p]; break; }
            }
            if (!panel) return { active: true, selected: false, changed: false };

            var props = panel.memoizedProps;
            var inspected = props.inspected;

            // RN allocates a fresh object per tap, so identity - not value -
            // distinguishes two consecutive taps on the same element.
            if (inspected === globalThis.__execbro_lastInspected) {
                return { active: true, selected: true, changed: false };
            }
            globalThis.__execbro_lastInspected = inspected;

            var names = [];
            for (var i = 0; i < props.hierarchy.length; i++) {
                names.push(props.hierarchy[i].name);
            }

            var style = {};
            if (inspected && inspected.style) {
                var list = Array.isArray(inspected.style) ? inspected.style : [inspected.style];
                for (var s = 0; s < list.length; s++) {
                    if (list[s] && typeof list[s] === 'object') {
                        for (var k in list[s]) { style[k] = list[s][k]; }
                    }
                }
            }

            return {
                active: true,
                selected: true,
                changed: true,
                element: names.length > 0 ? names[names.length - 1] : 'Unknown',
                path: names.join(' > '),
                hierarchy: names,
                frame: inspected && inspected.frame ? inspected.frame : null,
                style: Object.keys(style).length > 0 ? style : null
            };
        })()
    `;
}

/**
 * Hit-tests at (x, y) and harvests raw _debugStack strings up the return chain.
 * Measures host fibers, so this runs only when the probe reports a change -
 * once per tap, never per tick.
 *
 * Prefers _debugSource when present (React < 19, already source coordinates);
 * otherwise emits the raw _debugStack string for host-side symbolication.
 *
 * The cap is deliberately generous. Real trees bury the nearest user component
 * deep behind library wrappers - measured on a production app, a tapped SearchBar
 * sat 12 ancestors above the hit fiber (SVG icon, Pressable and View wrappers in
 * between) and HomeScreen sat at 22. Collapsed library frames are dropped
 * host-side, so a larger walk improves recall without bloating the output; the
 * extra frames cost nothing beyond one batched, cached symbolicate request.
 */
export function buildDebugStackHarvestExpression(
    x: number,
    y: number,
    maxAncestors: number = 30
): string {
    return `
        new Promise(function(resolve) {
            var maxAncestors = ${maxAncestors};
            ${ROOTS_SNIPPET}
            if (roots.length === 0) return resolve({ stacks: [], error: 'no-fiber-roots' });

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
                            try { globalThis.nativeFabricUIManager.measureInWindow(node, cb); } catch (e) {}
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
            for (var r = 0; r < roots.length; r++) { walkFibers(roots[r].current, 0); }
            if (hostFibers.length === 0) return resolve({ stacks: [], error: 'no-host-fibers' });

            var measurements = new Array(hostFibers.length).fill(null);
            var pending = hostFibers.length;
            var settled = false;

            function collect() {
                if (settled) return;
                settled = true;

                var targetX = ${x};
                var targetY = ${y};
                var hits = [];
                for (var i = 0; i < measurements.length; i++) {
                    var m = measurements[i];
                    if (m && m.width > 0 && m.height > 0 &&
                        targetX >= m.x && targetX <= m.x + m.width &&
                        targetY >= m.y && targetY <= m.y + m.height) {
                        hits.push({ fiber: hostFibers[i], area: m.width * m.height });
                    }
                }
                if (hits.length === 0) return resolve({ stacks: [], error: 'no-hit' });
                hits.sort(function(a, b) { return a.area - b.area; });

                var stacks = [];
                var node = hits[0].fiber;
                while (node && stacks.length < maxAncestors) {
                    var name = null;
                    if (node.type) {
                        name = typeof node.type === 'string'
                            ? node.type
                            : (node.type.displayName || node.type.name);
                    }
                    if (name) {
                        var src = node._debugSource;
                        if (src && src.fileName) {
                            stacks.push({
                                component: name,
                                stack: '',
                                file: src.fileName,
                                lineNumber: src.lineNumber,
                                column: src.columnNumber
                            });
                        } else if (node._debugStack && node._debugStack.stack) {
                            stacks.push({ component: name, stack: String(node._debugStack.stack) });
                        }
                    }
                    node = node.return;
                }
                resolve({ stacks: stacks });
            }

            hostFibers.forEach(function(fiber, i) {
                try {
                    getMeasurable(fiber).measureInWindow(function(fx, fy, fw, fh) {
                        measurements[i] = { x: fx, y: fy, width: fw, height: fh };
                        if (--pending === 0) collect();
                    });
                } catch (e) {
                    if (--pending === 0) collect();
                }
            });

            setTimeout(collect, 300);
        })
    `;
}

export interface RawComponentStack {
    component: string;
    stack: string;
    /** Present only on React < 19, where _debugSource still exists. */
    file?: string;
    lineNumber?: number;
    column?: number;
}

export interface SourceLocation {
    file: string;
    line: number;
    column: number;
}

export interface ResolvedAncestor {
    component: string;
    file: string;
    line: number;
}

export interface ResolvedSource {
    source: SourceLocation | null;
    ancestors: ResolvedAncestor[];
    sourceUnavailable?: string;
}

/**
 * Frame index 1 of a parsed _debugStack is the component's render site - the
 * JSX call site in its parent, which is the line a developer edits. Index 0 is
 * the Error construction inside React's jsx runtime.
 */
const RENDER_SITE_FRAME_INDEX = 1;

export async function resolveStacksToSource(stacks: RawComponentStack[]): Promise<ResolvedSource> {
    if (stacks.length === 0) {
        return { source: null, ancestors: [], sourceUnavailable: "no-debug-stack" };
    }

    // React < 19 path: _debugSource already carries source coordinates.
    const direct: ResolvedAncestor[] = [];
    const needsSymbolication: Array<{ component: string; frame: StackFrame }> = [];

    for (const entry of stacks) {
        if (entry.file && entry.lineNumber !== undefined) {
            direct.push({ component: entry.component, file: entry.file, line: entry.lineNumber });
            continue;
        }
        const frames = parseStackString(entry.stack, RENDER_SITE_FRAME_INDEX + 1);
        const renderSite = frames[RENDER_SITE_FRAME_INDEX];
        if (renderSite) {
            needsSymbolication.push({ component: entry.component, frame: renderSite });
        }
    }

    if (needsSymbolication.length === 0) {
        if (direct.length === 0) {
            return { source: null, ancestors: [], sourceUnavailable: "no-debug-stack" };
        }
        const first = direct[0];
        const firstEntry = stacks.find((s) => s.component === first.component);
        return {
            source: { file: first.file, line: first.line, column: firstEntry?.column ?? 0 },
            ancestors: direct,
        };
    }

    const resolved = await symbolicateFrames(needsSymbolication.map((n) => n.frame));
    if (resolved === null) {
        return { source: null, ancestors: [], sourceUnavailable: "symbolicate-unreachable" };
    }

    const ancestors: ResolvedAncestor[] = [...direct];
    let best: SourceLocation | null = null;

    resolved.forEach((frame, i) => {
        const component = needsSymbolication[i]?.component;
        if (!component || frame.collapse) return;
        ancestors.push({ component, file: frame.file, line: frame.lineNumber });
        if (!best) {
            best = { file: frame.file, line: frame.lineNumber, column: frame.column };
        }
    });

    if (!best && direct.length > 0) {
        best = { file: direct[0].file, line: direct[0].line, column: 0 };
    }

    if (!best) {
        return { source: null, ancestors: [], sourceUnavailable: "library-only" };
    }

    return { source: best, ancestors };
}
