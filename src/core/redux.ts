import { executeInApp } from "./executor.js";

const FIBER_WALK = `
var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (!hook || !hook.renderers || !hook.getFiberRoots) {
    return JSON.stringify({ ok: false, error: 'React DevTools hook not available — app must be run in dev mode with React Native renderer registered.' });
}
function isStore(v) {
    return !!v && typeof v === 'object' && typeof v.dispatch === 'function' && typeof v.getState === 'function' && typeof v.subscribe === 'function';
}
function displayName(t) {
    if (!t) return undefined;
    if (typeof t === 'string') return t;
    return t.displayName || t.name;
}
var found = [];
function walk(f, d) {
    if (!f || d > 1500 || found.length > 32) return;
    if (displayName(f.type) === 'Provider' && f.memoizedProps && isStore(f.memoizedProps.store)) {
        found.push(f.memoizedProps.store);
    }
    if (f.child) walk(f.child, d + 1);
    if (f.sibling) walk(f.sibling, d);
}
var ids = [];
hook.renderers.forEach(function (_, k) { ids.push(k); });
for (var i = 0; i < ids.length; i++) {
    var roots = hook.getFiberRoots(ids[i]);
    if (!roots) continue;
    roots.forEach(function (r) { walk(r.current, 0); });
}
if (found.length === 0) {
    return JSON.stringify({ ok: false, error: 'No <Provider store> with a redux-shaped store found in the fiber tree.' });
}
`;

function buildExpression(body: string): string {
    return `(function(){ ${FIBER_WALK} ${body} })()`;
}

export interface ReduxDispatchOptions {
    action: Record<string, unknown>;
    storeIndex?: number;
    returnPath?: string;
    device?: string;
}

export interface ReduxResult {
    success: boolean;
    error?: string;
    storeCount?: number;
    storeIndex?: number;
    state?: unknown;
    previousAction?: unknown;
}

async function runReduxExpression(expression: string, originatingToolName: string, device?: string): Promise<ReduxResult> {
    const exec = await executeInApp(expression, false, { timeoutMs: 15000, originatingToolName }, device);
    if (!exec.success) {
        return { success: false, error: exec.error || "Execution failed" };
    }
    const raw = exec.result;
    if (typeof raw !== "string") {
        return { success: false, error: `Unexpected result type from app: ${typeof raw}` };
    }
    let parsed: { ok: boolean; error?: string; state?: unknown; storeCount?: number; storeIndex?: number; action?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { success: false, error: `Failed to parse app response: ${(e as Error).message}` };
    }
    if (!parsed.ok) {
        return { success: false, error: parsed.error };
    }
    return {
        success: true,
        storeCount: parsed.storeCount,
        storeIndex: parsed.storeIndex,
        state: parsed.state,
        previousAction: parsed.action,
    };
}

export async function reduxDispatch(options: ReduxDispatchOptions): Promise<ReduxResult> {
    const { action, storeIndex = 0, returnPath, device } = options;
    const actionJson = JSON.stringify(action);
    const pathLiteral = returnPath ? JSON.stringify(returnPath) : "null";
    const body = `
        var idx = ${Number(storeIndex) || 0};
        if (idx < 0 || idx >= found.length) {
            return JSON.stringify({ ok: false, error: 'storeIndex ' + idx + ' out of range; ' + found.length + ' Provider store(s) found.', storeCount: found.length });
        }
        var store = found[idx];
        var action = JSON.parse(${JSON.stringify(actionJson)});
        store.dispatch(action);
        var pathStr = ${pathLiteral};
        var state;
        if (pathStr) {
            var slice = store.getState();
            var parts = pathStr.split('.');
            for (var i = 0; i < parts.length; i++) {
                if (slice == null) break;
                slice = slice[parts[i]];
            }
            try { state = JSON.parse(JSON.stringify(slice)); } catch (e) { state = { __error: 'state slice not JSON-serializable: ' + e.message }; }
        }
        return JSON.stringify({ ok: true, storeCount: found.length, storeIndex: idx, action: action, state: state });
    `;
    return runReduxExpression(buildExpression(body), "redux_dispatch", device);
}

export interface ReduxGetStateOptions {
    storeIndex?: number;
    path?: string;
    device?: string;
}

export async function reduxGetState(options: ReduxGetStateOptions = {}): Promise<ReduxResult> {
    const { storeIndex = 0, path, device } = options;
    const pathLiteral = path ? JSON.stringify(path) : "null";
    const body = `
        var idx = ${Number(storeIndex) || 0};
        if (idx < 0 || idx >= found.length) {
            return JSON.stringify({ ok: false, error: 'storeIndex ' + idx + ' out of range; ' + found.length + ' Provider store(s) found.', storeCount: found.length });
        }
        var store = found[idx];
        var state = store.getState();
        var pathStr = ${pathLiteral};
        if (pathStr) {
            var parts = pathStr.split('.');
            for (var i = 0; i < parts.length; i++) {
                if (state == null) break;
                state = state[parts[i]];
            }
        }
        var safe;
        try { safe = JSON.parse(JSON.stringify(state)); } catch (e) { safe = { __error: 'state not JSON-serializable: ' + e.message }; }
        return JSON.stringify({ ok: true, storeCount: found.length, storeIndex: idx, state: safe });
    `;
    return runReduxExpression(buildExpression(body), "redux_get_state", device);
}
