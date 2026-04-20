import WebSocket from "ws";
import { ExecutionResult, ExecuteOptions } from "./types.js";
import { pendingExecutions, getNextMessageId, connectedApps } from "./state.js";
import { getFirstConnectedApp, getConnectedAppByDevice, connectToDevice } from "./connection.js";
import { fetchDevices, selectMainDevice, scanMetroPorts } from "./metro.js";
import { DEFAULT_RECONNECTION_CONFIG, cancelReconnectionTimer } from "./connectionState.js";

// Hermes runtime compatibility: polyfill for 'global' which doesn't exist in Hermes
// In Hermes, globalThis is the standard way to access global scope
const GLOBAL_POLYFILL = `var global = typeof global !== 'undefined' ? global : globalThis;`;

// ============================================================================
// Expression Preprocessing & Validation
// ============================================================================

export interface ExpressionValidation {
    valid: boolean;
    expression: string;
    error?: string;
}

/**
 * Check if a string contains emoji or other problematic Unicode characters
 * Hermes has issues with certain UTF-16 surrogate pairs (like emoji)
 */
export function containsProblematicUnicode(str: string): boolean {
    // Detect UTF-16 surrogate pairs (emoji and other characters outside BMP)
    // These cause "Invalid UTF-8 code point" errors in Hermes
    // eslint-disable-next-line no-control-regex
    return /[\uD800-\uDFFF]/.test(str);
}

/**
 * Strip leading comments from an expression
 * Users often start with // comments which break the (return expr) wrapping
 */
export function stripLeadingComments(expression: string): string {
    let result = expression;

    // Strip leading whitespace first
    result = result.trimStart();

    // Repeatedly strip leading single-line comments (// ...)
    while (result.startsWith("//")) {
        const newlineIndex = result.indexOf("\n");
        if (newlineIndex === -1) {
            // Entire expression is a comment
            return "";
        }
        result = result.slice(newlineIndex + 1).trimStart();
    }

    // Strip leading multi-line comments (/* ... */)
    while (result.startsWith("/*")) {
        const endIndex = result.indexOf("*/");
        if (endIndex === -1) {
            // Unclosed comment
            return result;
        }
        result = result.slice(endIndex + 2).trimStart();
    }

    return result;
}

/**
 * Validate and preprocess an expression before execution
 * Returns cleaned expression or error with helpful message
 */
export function validateAndPreprocessExpression(expression: string): ExpressionValidation {
    // Check for emoji/problematic Unicode before any processing
    if (containsProblematicUnicode(expression)) {
        return {
            valid: false,
            expression,
            error:
                "Expression contains emoji or special Unicode characters that Hermes cannot compile. " +
                "Please remove emoji and use ASCII characters only."
        };
    }

    // Strip leading comments that would break the expression wrapper
    const cleaned = stripLeadingComments(expression);

    if (!cleaned.trim()) {
        return {
            valid: false,
            expression,
            error: "Expression is empty or contains only comments."
        };
    }

    // Check for top-level async that Hermes doesn't support in Runtime.evaluate
    // Pattern: starts with (async or async keyword at expression level
    const trimmed = cleaned.trim();
    if (trimmed.startsWith("(async") || trimmed.startsWith("async ") || trimmed.startsWith("async(")) {
        return {
            valid: false,
            expression: cleaned,
            error:
                "Hermes does not support top-level async functions in Runtime.evaluate. " +
                "Instead of `(async () => { ... })()`, use a synchronous approach or " +
                "execute the async code and access the result via a global variable: " +
                "`global.__result = null; myAsyncFn().then(r => global.__result = r)`"
        };
    }

    // Check for require() calls that don't work in Hermes Runtime.evaluate
    if (/\brequire\s*\(/.test(trimmed)) {
        return {
            valid: false,
            expression: cleaned,
            error:
                "require() is not available in Hermes Runtime.evaluate. " +
                "Modules cannot be imported at runtime. Only pre-existing global variables are accessible. " +
                "Use list_debug_globals to discover available globals, or add `globalThis.__MY_VAR__ = myModule;` in your app code."
        };
    }

    return {
        valid: true,
        expression: cleaned
    };
}

// Error patterns that indicate a stale/destroyed context
const CONTEXT_ERROR_PATTERNS = [
    "cannot find context",
    "execution context was destroyed",
    "target closed",
    "inspected target navigated",
    "session closed",
    "context with specified id",
    "no execution context",
    "runningdetached"
];

/**
 * Check if an error indicates a stale page context
 */
function isContextError(error: string | undefined): boolean {
    if (!error) return false;
    const lowerError = error.toLowerCase();
    return CONTEXT_ERROR_PATTERNS.some((pattern) => lowerError.includes(pattern));
}

/**
 * Simple delay helper
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt quick reconnection to Metro
 */
async function attemptQuickReconnect(preferredPort?: number): Promise<boolean> {
    try {
        const ports = await scanMetroPorts();
        const targetPort = preferredPort && ports.includes(preferredPort) ? preferredPort : ports[0];

        if (!targetPort) return false;

        const devices = await fetchDevices(targetPort);
        const mainDevice = selectMainDevice(devices);
        if (!mainDevice) return false;

        await connectToDevice(mainDevice, targetPort);
        return true;
    } catch {
        return false;
    }
}

/**
 * Execute expression on a connected app (core implementation without retry)
 */
async function executeExpressionCore(
    expression: string,
    awaitPromise: boolean,
    timeoutMs: number = 10000
): Promise<ExecutionResult> {
    const app = getFirstConnectedApp();

    if (!app) {
        return { success: false, error: "No apps connected. Run 'scan_metro' first." };
    }

    if (app.ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: "WebSocket connection is not open." };
    }

    // Validate and preprocess the expression
    const validation = validateAndPreprocessExpression(expression);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    const cleanedExpression = validation.expression;

    // Hermes CDP does not support awaitPromise — it serializes the Promise's
    // internal fields (_A, _x, _y, _z) instead of waiting for resolution.
    // When the caller wants awaitPromise, we handle it ourselves: wrap the
    // expression to store the resolved value in a temp global, then poll.
    if (awaitPromise) {
        return executeWithManualAwait(app, cleanedExpression, timeoutMs);
    }

    return executeCDP(app, cleanedExpression, false, timeoutMs);
}

/**
 * Execute a CDP Runtime.evaluate call (no promise awaiting).
 */
function executeCDP(
    app: ReturnType<typeof getFirstConnectedApp> & {},
    cleanedExpression: string,
    awaitPromise: boolean,
    timeoutMs: number
): Promise<ExecutionResult> {
    const TIMEOUT_MS = timeoutMs;
    const currentMessageId = getNextMessageId();
    const wrappedExpression = `${GLOBAL_POLYFILL} ${cleanedExpression}`;

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            pendingExecutions.delete(currentMessageId);

            const wsState = app.ws.readyState === WebSocket.OPEN ? "OPEN"
                : app.ws.readyState === WebSocket.CLOSED ? "CLOSED"
                : app.ws.readyState === WebSocket.CLOSING ? "CLOSING"
                : "CONNECTING";
            const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
            const pageId = app.deviceInfo.id || "unknown";
            const truncatedExpr = cleanedExpression.length > 100
                ? cleanedExpression.substring(0, 100) + "..."
                : cleanedExpression;

            const errorMessage = [
                "Timeout: Expression took too long to evaluate.",
                "",
                `Connection state: ws=${wsState}, device="${deviceName}", platform=${app.platform}, pageId=${pageId}`,
                `Expression (truncated): ${truncatedExpr}`,
                "",
                "This usually means the JavaScript execution context became unresponsive or the CDP page is stale.",
                "",
                "Recovery steps (try in order):",
                "1. Call scan_metro to re-establish a fresh CDP connection",
                "2. If scan_metro doesn't help, force-restart the app:",
                "   - iOS: ios_terminate_app then ios_launch_app",
                "   - Android: android_launch_app (restarts automatically)",
                "3. After restarting, call scan_metro again to reconnect",
            ].join("\n");

            resolve({ success: false, error: errorMessage });
        }, TIMEOUT_MS);

        pendingExecutions.set(currentMessageId, { resolve, timeoutId });

        try {
            app.ws.send(
                JSON.stringify({
                    id: currentMessageId,
                    method: "Runtime.evaluate",
                    params: {
                        expression: wrappedExpression,
                        returnByValue: true,
                        awaitPromise,
                        userGesture: true,
                        generatePreview: true
                    }
                })
            );
        } catch (error) {
            clearTimeout(timeoutId);
            pendingExecutions.delete(currentMessageId);
            resolve({
                success: false,
                error: `Failed to send: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    });
}

/**
 * Hermes workaround for awaitPromise: execute the expression, and if it
 * returns a Promise, store the resolved/rejected value in a temp global
 * and read it back with a small number of spaced-out retries.
 */
async function executeWithManualAwait(
    app: ReturnType<typeof getFirstConnectedApp> & {},
    cleanedExpression: string,
    timeoutMs: number
): Promise<ExecutionResult> {
    const slotId = `__rn_dbg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Wrap: run the expression, if result is thenable store resolved value in
    // a temp global slot; otherwise store the sync value immediately.
    const wrapperExpr = `(function(){
var __v=(${cleanedExpression});
if(__v&&typeof __v==='object'&&typeof __v.then==='function'){
globalThis['${slotId}']={s:'pending'};
__v.then(function(r){globalThis['${slotId}']={s:'ok',v:r}},function(e){globalThis['${slotId}']={s:'err',v:String(e)}});
return '__awaiting__'}
else{return __v}})()`;

    const initial = await executeCDP(app, wrapperExpr, false, timeoutMs);

    // If the expression didn't return a Promise, return the result directly
    if (!initial.success || initial.result !== "__awaiting__") {
        return initial;
    }

    // Read the settled value with a few spaced-out retries (not aggressive polling).
    // Most Promises resolve within a microtask or a single event loop tick.
    const RETRY_DELAYS_MS = [100, 300, 600, 1000, 2000, 3000];
    const readExpr = `(function(){var s=globalThis['${slotId}'];if(!s||s.s==='pending')return '__pending__';delete globalThis['${slotId}'];return{status:s.s,value:s.v}})()`;

    for (const delayMs of RETRY_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delayMs));

        const poll = await executeCDP(app, readExpr, false, 5000);

        if (!poll.success) return poll;
        if (poll.result === "__pending__") continue;

        // The poll result comes through formatRemoteObject — objects are
        // JSON.stringified, so we need to parse it back.
        try {
            const parsed = typeof poll.result === "string" ? JSON.parse(poll.result) : poll.result;
            if (parsed?.status === "err") {
                return { success: false, error: parsed.value || "Promise rejected" };
            }
            const value = parsed?.value;
            return {
                success: true,
                result: value === undefined || value === null
                    ? String(value)
                    : typeof value === "object"
                        ? JSON.stringify(value, null, 2)
                        : String(value)
            };
        } catch {
            return poll;
        }
    }

    // Cleanup on timeout
    await executeCDP(app, `delete globalThis['${slotId}']`, false, 2000).catch(() => {});
    return { success: false, error: "Timeout: Promise did not resolve within the time limit." };
}

// Execute JavaScript in the connected React Native app with retry logic
export async function executeInApp(
    expression: string,
    awaitPromise: boolean = true,
    options: ExecuteOptions = {},
    device?: string
): Promise<ExecutionResult> {
    const { maxRetries = 2, retryDelayMs = 1000, autoReconnect = true, timeoutMs = 10000 } = options;

    let lastError: string | undefined;
    let preferredPort: number | undefined;

    // Get preferred port from current connection if available
    const currentApp = getConnectedAppByDevice(device);
    if (currentApp) {
        preferredPort = currentApp.port;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const app = getConnectedAppByDevice(device);

        // No connection - try to reconnect if enabled
        if (!app) {
            if (autoReconnect && attempt < maxRetries) {
                console.error(
                    `[rn-ai-debugger] No connection, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`
                );
                const reconnected = await attemptQuickReconnect(preferredPort);
                if (reconnected) {
                    await delay(retryDelayMs);
                    continue;
                }
            }
            return { success: false, error: "No apps connected. Run 'scan_metro' first." };
        }

        // WebSocket not open - try to reconnect
        if (app.ws.readyState !== WebSocket.OPEN) {
            if (autoReconnect && attempt < maxRetries) {
                console.error(
                    `[rn-ai-debugger] WebSocket not open, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`
                );
                // Close stale connection
                const appKey = `${app.port}-${app.deviceInfo.id}`;
                cancelReconnectionTimer(appKey);
                try {
                    app.ws.close();
                } catch {
                    /* ignore */
                }
                connectedApps.delete(appKey);

                const reconnected = await attemptQuickReconnect(app.port);
                if (reconnected) {
                    await delay(retryDelayMs);
                    continue;
                }
            }
            return { success: false, error: "WebSocket connection is not open." };
        }

        // Execute the expression
        const result = await executeExpressionCore(expression, awaitPromise, timeoutMs);

        // Success - return result
        if (result.success) {
            return result;
        }

        lastError = result.error;

        // Check if this is a context error that might be recoverable
        if (isContextError(result.error)) {
            if (autoReconnect && attempt < maxRetries) {
                console.error(
                    `[rn-ai-debugger] Context error detected, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`
                );

                // Close and reconnect
                const appKey = `${app.port}-${app.deviceInfo.id}`;
                cancelReconnectionTimer(appKey);
                try {
                    app.ws.close();
                } catch {
                    /* ignore */
                }
                connectedApps.delete(appKey);

                const reconnected = await attemptQuickReconnect(app.port);
                if (reconnected) {
                    await delay(retryDelayMs);
                    continue;
                }
            }
        }

        // Non-context error or no more retries - return error
        return result;
    }

    return {
        success: false,
        error: lastError ?? [
            "Execution failed after all retries. Connection may be stale.",
            "",
            "Recovery steps (try in order):",
            "1. Call scan_metro to re-establish a fresh CDP connection",
            "2. If scan_metro doesn't help, force-restart the app:",
            "   - iOS: ios_terminate_app then ios_launch_app",
            "   - Android: android_launch_app (restarts automatically)",
            "3. After restarting, call scan_metro again to reconnect",
        ].join("\n")
    };
}

// List globally available debugging objects in the app
export async function listDebugGlobals(device?: string): Promise<ExecutionResult> {
    const expression = `
        (function() {
            const globals = Object.keys(globalThis);
            const categories = {
                'Apollo Client': globals.filter(k => k.includes('APOLLO')),
                'Redux': globals.filter(k => k.includes('REDUX')),
                'React DevTools': globals.filter(k => k.includes('REACT_DEVTOOLS')),
                'Reanimated': globals.filter(k => k.includes('reanimated') || k.includes('worklet')),
                'Expo': globals.filter(k => k.includes('Expo') || k.includes('expo')),
                'Metro': globals.filter(k => k.includes('METRO')),
                'Other Debug': globals.filter(k => k.startsWith('__') && !k.includes('APOLLO') && !k.includes('REDUX') && !k.includes('REACT_DEVTOOLS') && !k.includes('reanimated') && !k.includes('worklet') && !k.includes('Expo') && !k.includes('expo') && !k.includes('METRO'))
            };
            return categories;
        })()
    `;

    return executeInApp(expression, false, {}, device);
}

// Inspect a global object to see its properties and types
export async function inspectGlobal(objectName: string, device?: string): Promise<ExecutionResult> {
    const expression = `
        (function() {
            const obj = ${objectName};
            if (obj === undefined) return { error: 'Object not found' };
            const result = {};
            for (const key of Object.keys(obj)) {
                const val = obj[key];
                const type = typeof val;
                if (type === 'function') {
                    result[key] = { type: 'function', callable: true };
                } else if (type === 'object' && val !== null) {
                    result[key] = { type: Array.isArray(val) ? 'array' : 'object', callable: false, preview: JSON.stringify(val).slice(0, 100) };
                } else {
                    result[key] = { type, callable: false, value: val };
                }
            }
            return result;
        })()
    `;

    return executeInApp(expression, false, {}, device);
}

// Reload the React Native app using __ReactRefresh
// Note: Page.reload CDP method may work on Bridgeless targets (via HostAgent) — not yet tested
// Uses fire-and-forget: sends the reload command without waiting for a response,
// since the JS context is destroyed during reload and would always timeout.
export async function reloadApp(device?: string): Promise<ExecutionResult> {
    // Get current connection info before reload
    let app = getConnectedAppByDevice(device);

    // Auto-connect if no connection exists
    if (!app) {
        console.error("[rn-ai-debugger] No connection for reload, attempting auto-connect...");

        // Try to find and connect to a Metro server
        const ports = await scanMetroPorts();
        if (ports.length === 0) {
            return {
                success: false,
                error: "No apps connected and no Metro server found. Make sure Metro bundler is running (npm start or expo start), then try again."
            };
        }

        // Try to connect to the first available Metro server
        for (const port of ports) {
            const devices = await fetchDevices(port);
            const mainDevice = selectMainDevice(devices);
            if (mainDevice) {
                try {
                    await connectToDevice(mainDevice, port);
                    console.error(`[rn-ai-debugger] Auto-connected to ${mainDevice.title} on port ${port}`);
                    app = getConnectedAppByDevice(device);
                    break;
                } catch (error) {
                    console.error(`[rn-ai-debugger] Failed to connect to port ${port}: ${error}`);
                }
            }
        }

        // Check if auto-connect succeeded
        if (!app) {
            return {
                success: false,
                error: "No apps connected. Found Metro server but could not connect to any device. Make sure the React Native app is running."
            };
        }
    }

    const port = app.port;

    // Fire-and-forget: send reload command via CDP without waiting for response.
    // The JS context is destroyed during reload, so Runtime.evaluate would always timeout.
    const reloadExpression = `(function() {
        try {
            if (typeof __ReactRefresh !== 'undefined' && typeof __ReactRefresh.performFullRefresh === 'function') {
                __ReactRefresh.performFullRefresh('mcp-reload');
                return 'ok';
            }
            if (typeof global !== 'undefined' && global.DevSettings && typeof global.DevSettings.reload === 'function') {
                global.DevSettings.reload();
                return 'ok';
            }
            return 'no-method';
        } catch (e) { return 'error:' + e.message; }
    })()`;

    try {
        if (app.ws.readyState !== WebSocket.OPEN) {
            const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
            return {
                success: false,
                error: [
                    `WebSocket connection is not open (device="${deviceName}", platform=${app.platform}).`,
                    "The CDP page may be stale or the app has crashed.",
                    "",
                    "Recovery steps (try in order):",
                    "1. Call scan_metro to re-establish a fresh CDP connection",
                    "2. If scan_metro doesn't help, force-restart the app:",
                    "   - iOS: ios_terminate_app then ios_launch_app",
                    "   - Android: android_launch_app (restarts automatically)",
                    "3. After restarting, call scan_metro again to reconnect",
                ].join("\n")
            };
        }

        // Send without registering a pending execution — fire and forget
        const messageId = getNextMessageId();
        app.ws.send(
            JSON.stringify({
                id: messageId,
                method: "Runtime.evaluate",
                params: {
                    expression: reloadExpression,
                    returnByValue: true,
                    awaitPromise: false,
                    userGesture: true
                }
            })
        );
    } catch (error) {
        return {
            success: false,
            error: `Failed to send reload command: ${error instanceof Error ? error.message : String(error)}`
        };
    }

    // Auto-reconnect after reload
    try {
        // Wait for app to reload (give it time to restart JS context)
        await delay(2000);

        // Find and close only the targeted device's connection (not all devices on this port)
        const targetDeviceId = app.deviceInfo.id;
        for (const [key, connectedApp] of connectedApps.entries()) {
            if (connectedApp.deviceInfo.id === targetDeviceId) {
                cancelReconnectionTimer(key);
                try {
                    connectedApp.ws.close();
                } catch {
                    // Ignore close errors
                }
                connectedApps.delete(key);
                break;
            }
        }

        // Small delay to ensure cleanup
        await delay(500);

        // Reconnect only the reloaded device (not all devices on the port)
        const devices = await fetchDevices(port);
        const targetDevice = devices.find(d => d.id === targetDeviceId)
            || devices.find(d => d.deviceName === app.deviceInfo.deviceName);

        if (targetDevice) {
            await connectToDevice(targetDevice, port, {
                isReconnection: false,
                reconnectionConfig: { ...DEFAULT_RECONNECTION_CONFIG, enabled: false }
            });
            return {
                success: true,
                result: `App reloaded and reconnected to ${targetDevice.deviceName || targetDevice.title}`
            };
        } else {
            return {
                success: true,
                result: "App reloaded but could not auto-reconnect. Run 'scan_metro' to reconnect."
            };
        }
    } catch (error) {
        return {
            success: true,
            result: `App reloaded but auto-reconnect failed: ${error instanceof Error ? error.message : String(error)}. Run 'scan_metro' to reconnect.`
        };
    }
}

// ============================================================================
// React Component Tree Inspection (via DevTools Global Hook)
// ============================================================================

// TONL (Token-Optimized Notation Language) formatters for component tools
// These reduce token usage by 40-60% compared to JSON for nested/repetitive structures

interface ComponentTreeNode {
    component: string;
    children?: ComponentTreeNode[];
    props?: Record<string, unknown>;
    layout?: Record<string, unknown>;
}

function formatTreeToTonl(node: ComponentTreeNode, indent = 0): string {
    const prefix = "  ".repeat(indent);
    let result = `${prefix}${node.component}`;

    // Add props inline if present
    if (node.props && Object.keys(node.props).length > 0) {
        const propsStr = Object.entries(node.props)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(",");
        result += ` (${propsStr})`;
    }

    // Add layout inline if present
    if (node.layout && Object.keys(node.layout).length > 0) {
        const layoutStr = Object.entries(node.layout)
            .map(([k, v]) => `${k}:${v}`)
            .join(",");
        result += ` [${layoutStr}]`;
    }

    result += "\n";

    // Recurse children
    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            result += formatTreeToTonl(child, indent + 1);
        }
    }

    return result;
}

// Ultra-compact structure-only tree format (just component names, indented)
function formatTreeStructureOnly(node: ComponentTreeNode, indent = 0): string {
    const prefix = "  ".repeat(indent);
    let result = `${prefix}${node.component}\n`;

    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            result += formatTreeStructureOnly(child, indent + 1);
        }
    }

    return result;
}

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

function formatScreenLayoutTree(elements: ScreenElement[], extended: boolean = false): string {
    return formatLayoutTree(elements, (el, indent, isLeaf) => {
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
export async function getComponentTree(
    options: {
        maxDepth?: number;
        includeProps?: boolean;
        includeStyles?: boolean;
        hideInternals?: boolean;
        format?: "json" | "tonl";
        structureOnly?: boolean;
        focusedOnly?: boolean;
        device?: string;
    } = {}
): Promise<ExecutionResult> {
    const {
        includeProps = false,
        includeStyles = false,
        hideInternals = true,
        format = "tonl",
        structureOnly = false,
        focusedOnly = false,
        device
    } = options;
    // Use lower default depth for structureOnly to keep output compact (~2-5KB)
    // Full mode uses higher depth since TONL format handles it better
    // focusedOnly mode uses moderate depth since we're already filtering to active screen
    const maxDepth = options.maxDepth ?? 5000;

    const expression = `
        (function() {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found. Make sure you are running a development build.' };

            // Try to get fiber roots (renderer ID is usually 1)
            let roots = [];
            if (hook.getFiberRoots) {
                roots = [...(hook.getFiberRoots(1) || [])];
            }
            if (roots.length === 0 && hook.renderers) {
                // Try all renderers
                for (const [id] of hook.renderers) {
                    const r = hook.getFiberRoots ? [...(hook.getFiberRoots(id) || [])] : [];
                    if (r.length > 0) {
                        roots = r;
                        break;
                    }
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found. The app may not have rendered yet.' };

            const maxDepth = ${maxDepth};
            const includeProps = ${includeProps};
            const includeStyles = ${includeStyles};
            const hideInternals = ${hideInternals};
            const focusedOnly = ${focusedOnly};

            // Internal RN components to hide
            const internalPatterns = /^(RCT|RNS|Animated\\(|AnimatedComponent|VirtualizedList|CellRenderer|ScrollViewContext|PerformanceLoggerContext|RootTagContext|HeaderShownContext|HeaderHeightContext|HeaderBackContext|SafeAreaFrameContext|SafeAreaInsetsContext|VirtualizedListContext|VirtualizedListCellContextProvider|StaticContainer|DelayedFreeze|Freeze|Suspender|DebugContainer|MaybeNestedStack|SceneView|NavigationContent|PreventRemoveProvider|EnsureSingleNavigator)/;

            // Screen component patterns - user's actual screens (strict matching)
            // Only match *Screen and *Page to avoid false positives like BottomTabView
            const screenPatterns = /^[A-Z][a-zA-Z0-9]*(Screen|Page)$/;

            // Navigation/internal screen patterns to SKIP (these look like screens but are framework components)
            const internalScreenPatterns = /^(MaybeScreen|Screen$|ScreenContainer|ScreenStack|SceneView|Background$)/;

            // Provider/wrapper patterns to skip when finding focused screen
            const wrapperPatterns = /^(App|AppContainer|Provider|Context|SafeArea|Gesture|Theme|Redux|Root|Navigator|Stack|Tab|Drawer|Navigation|Container|Wrapper|Layout|ErrorBoundary|Suspense|PersistGate|LinkingContext|AppState|View|Fragment|NativeStack|BottomTab|Screen$)/i;

            // Global overlay patterns - stop traversing into these subtrees
            // Be specific to avoid blocking BottomSheetDrawer, PortalProvider, etc.
            const overlayPatterns = /^(BottomSheet$|BottomSheetGlobal|Modal$|Toast$|Snackbar$|Dialog$|Overlay$|Popup$|MyToast$|PaywallModal$|FullScreenBannerModal$)/i;

            // Navigation container patterns - skip traversing into these (screens inside are nav screens, not focused content)
            const navContainerPatterns = /^(RootNavigation|NativeStackNavigator|BottomTabNavigator|DrawerNavigator|TabNavigator|StackNavigator)/;

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type; // Host component (View, Text, etc.)
                return fiber.type.displayName || fiber.type.name || null;
            }

            function shouldHide(name) {
                if (!hideInternals || !name) return false;
                return internalPatterns.test(name);
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
                    const layoutKeys = [
                        'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
                        'paddingHorizontal', 'paddingVertical',
                        'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
                        'marginHorizontal', 'marginVertical',
                        'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
                        'flex', 'flexDirection', 'flexWrap', 'flexGrow', 'flexShrink',
                        'justifyContent', 'alignItems', 'alignSelf', 'alignContent',
                        'position', 'top', 'bottom', 'left', 'right',
                        'gap', 'rowGap', 'columnGap',
                        'borderWidth', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth'
                    ];

                    for (const key of layoutKeys) {
                        if (merged[key] !== undefined) layout[key] = merged[key];
                    }
                    return Object.keys(layout).length > 0 ? layout : null;
                } catch { return null; }
            }

            function walkFiber(fiber, depth) {
                if (!fiber || depth > maxDepth) return null;

                const name = getComponentName(fiber);

                // Skip anonymous/internal components unless they have meaningful children
                if (!name || shouldHide(name)) {
                    // Still traverse children
                    let child = fiber.child;
                    const children = [];
                    while (child) {
                        const childResult = walkFiber(child, depth);
                        if (childResult) children.push(childResult);
                        child = child.sibling;
                    }
                    // Return first meaningful child or null
                    return children.length === 1 ? children[0] : (children.length > 1 ? { component: '(Fragment)', children } : null);
                }

                const node = { component: name };

                // Include props if requested (excluding children and style for cleaner output)
                if (includeProps && fiber.memoizedProps) {
                    const props = {};
                    for (const key of Object.keys(fiber.memoizedProps)) {
                        if (key === 'children' || key === 'style') continue;
                        try {
                            const val = fiber.memoizedProps[key];
                            if (typeof val === 'function') {
                                props[key] = '[Function]';
                            } else if (typeof val === 'object' && val !== null) {
                                props[key] = Array.isArray(val) ? '[Array]' : '[Object]';
                            } else {
                                props[key] = val;
                            }
                        } catch {
                            props[key] = '[Animated Value]';
                        }
                    }
                    if (Object.keys(props).length > 0) node.props = props;
                }

                // Include layout styles if requested
                try {
                    if (includeStyles && fiber.memoizedProps?.style) {
                        const layout = extractLayoutStyles(fiber.memoizedProps.style);
                        if (layout) node.layout = layout;
                    }
                } catch { /* animated style — skip */ }

                // Traverse children
                let child = fiber.child;
                const children = [];
                while (child) {
                    const childResult = walkFiber(child, depth + 1);
                    if (childResult) children.push(childResult);
                    child = child.sibling;
                }
                if (children.length > 0) node.children = children;

                return node;
            }

            // Find focused screen if requested
            function findFocusedScreen(fiber, depth = 0) {
                if (!fiber || depth > 5000) return null;

                const name = getComponentName(fiber);

                // Skip overlays (BottomSheet, Modal, Toast, etc.) - don't traverse into them
                if (name && overlayPatterns.test(name)) {
                    return null;
                }

                // Skip navigation containers - screens inside are nav screens, not focused content
                if (name && navContainerPatterns.test(name)) {
                    return null;
                }

                // Check if this is a user's screen component (not framework internals)
                if (name && screenPatterns.test(name) && !wrapperPatterns.test(name) && !internalScreenPatterns.test(name)) {
                    return fiber;
                }

                // Search children
                let child = fiber.child;
                while (child) {
                    const found = findFocusedScreen(child, depth + 1);
                    if (found) return found;
                    child = child.sibling;
                }

                return null;
            }

            let startFiber = roots[0].current;
            let focusedScreenName = null;

            if (focusedOnly) {
                const focused = findFocusedScreen(roots[0].current);
                if (focused) {
                    startFiber = focused;
                    focusedScreenName = getComponentName(focused);
                }
            }

            const tree = walkFiber(startFiber, 0);

            if (focusedOnly && focusedScreenName) {
                return { focusedScreen: focusedScreenName, tree };
            }
            return { tree };
        })()
    `;

    // Use a longer timeout for component tree traversal — large apps can exceed 10s
    const result = await executeInApp(expression, false, { timeoutMs: 30000 }, device);

    // Apply formatting if requested
    if (result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.tree) {
                const prefix = parsed.focusedScreen ? `Focused: ${parsed.focusedScreen}\n\n` : "";

                // Structure-only mode: ultra-compact format with just component names
                if (structureOnly) {
                    const structure = formatTreeStructureOnly(parsed.tree);
                    return { success: true, result: prefix + structure };
                }
                // TONL format: compact with props/layout
                if (format === "tonl") {
                    const tonl = formatTreeToTonl(parsed.tree);
                    return { success: true, result: prefix + tonl };
                }
            }
        } catch {
            // If parsing fails, return original result
        }
    }

    return result;
}

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
): Promise<ExecutionResult & { parsedElements?: ScreenElement[]; viewport?: { width: number; height: number } }> {
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

            for (var i = 0; i < measurements.length; i++) {
                var m = measurements[i];
                if (!m) continue;

                // Filter: only visible within viewport (with some tolerance for partial visibility)
                if (m.width <= 0 || m.height <= 0) continue;
                if (m.x + m.width < 0 || m.y + m.height < 0) continue;
                if (m.x > viewportW || m.y > viewportH) continue;

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
                elements: elements
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
                        viewport: parsed.viewport
                    };
                }
                const tree = formatScreenLayoutTree(parsed.elements, extended);
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
}

export async function getPressableElements(
    options: { device?: string } = {}
): Promise<ExecutionResult & { parsedElements?: PressableElement[] }> {
    const { device } = options;

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

            return { count: hostFibers.length };
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
            globalThis.__pressableFibers = null;
            globalThis.__pressableMeta = null;
            globalThis.__pressableMeasurements = null;
            globalThis.__pressableRootIdx = null;

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

            // Format as readable text
            const lines: string[] = [parsed.summary, ""];
            for (let i = 0; i < pressableElements.length; i++) {
                const el = pressableElements[i];
                const num = i + 1;
                const label = el.hasLabel ? `"${el.text}"` : "(icon/image)";
                const ids: string[] = [];
                if (el.testID) ids.push(`testID="${el.testID}"`);
                if (el.accessibilityLabel) ids.push(`a11y="${el.accessibilityLabel}"`);
                const idStr = ids.length > 0 ? ` [${ids.join(", ")}]` : "";
                const inputStr = el.isInput ? " (input)" : "";
                const wrapperStr = el.isWrapper ? " [wrapper — skip unless dismissing keyboard]" : "";
                lines.push(
                    `${num}. ${el.component} ${label} — center:(${el.center.x},${el.center.y}) frame:(${el.frame.x},${el.frame.y} ${el.frame.width}x${el.frame.height})${idStr}${inputStr}${wrapperStr}`
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
function formatEnrichedLayoutTree(elements: EnrichedElement[]): string {
    return formatLayoutTree(elements, (el, indent, isLeaf) => {
        const prefix = "  ".repeat(indent);
        const frame = `(${Math.round(el.frame.x)},${Math.round(el.frame.y)} ${Math.round(el.frame.width)}x${Math.round(el.frame.height)})`;
        const tap = ` tap:(${el.tapX},${el.tapY})`;
        const id = el.identifiers?.testID || el.identifiers?.accessibilityLabel || "";
        const idStr = id ? ` [${id}]` : "";
        const textStr = el.text && isLeaf ? ` "${el.text}"` : "";
        return `${prefix}${el.component} ${frame}${tap}${idStr}${textStr}`;
    });
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
    device?: string
): Promise<string | null> {
    try {
        const result = await getScreenLayout({ extended: false, summary: false, device, raw: true });
        if (!result.success || !result.parsedElements || result.parsedElements.length === 0) return null;

        const elements: EnrichedElement[] = result.parsedElements.map((el: ScreenElement) => {
            const frame = el.frame || { x: 0, y: 0, width: 0, height: 0 };

            // Convert center point from points/dp to screenshot pixels
            // Points -> device pixels: multiply by pixelRatio
            // Device pixels -> screenshot pixels: divide by screenshotScaleFactor (if image was resized)
            const centerXPoints = frame.x + frame.width / 2;
            const centerYPoints = frame.y + frame.height / 2;
            const tapX = Math.round((centerXPoints * pixelRatio) / screenshotScaleFactor);
            const tapY = Math.round((centerYPoints * pixelRatio) / screenshotScaleFactor);

            // Convert frame to pixels too
            const pixelFrame = {
                x: Math.round((frame.x * pixelRatio) / screenshotScaleFactor),
                y: Math.round((frame.y * pixelRatio) / screenshotScaleFactor),
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

        return formatEnrichedLayoutTree(elements);
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

            function extractText(fiber, depth) {
                if (!fiber || depth > 5000) return '';
                var parts = [];
                var props = fiber.memoizedProps;
                if (props) {
                    var ch = props.children;
                    if (typeof ch === 'string') parts.push(ch);
                    else if (typeof ch === 'number') parts.push(String(ch));
                    else if (Array.isArray(ch)) {
                        for (var i = 0; i < ch.length; i++) {
                            if (typeof ch[i] === 'string') parts.push(ch[i]);
                            else if (typeof ch[i] === 'number') parts.push(String(ch[i]));
                        }
                    }
                }
                var child = fiber.child;
                while (child) {
                    parts.push(extractText(child, depth + 1));
                    child = child.sibling;
                }
                return parts.join('');
            }

            function getMeasurable(fiber) {
                var sn = fiber.stateNode;
                if (!sn) return null;
                if (typeof sn.measureInWindow === 'function') return sn;
                if (sn.canonical && sn.canonical.publicInstance &&
                    typeof sn.canonical.publicInstance.measureInWindow === 'function') {
                    return sn.canonical.publicInstance;
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
                success: true,
                pressed: target.name,
                matchIndex: targetIndex,
                totalMatches: matches.length,
                text: target.text,
                testID: target.testID,
                path: target.path,
                isInput: target.isInput,
                x: target.x,
                y: target.y,
                unit: 'points'
            };
            if (matches.length > 1) {
                result.allMatches = matches.map(function(m, i) {
                    return { index: i, component: m.name, text: m.text, testID: m.testID };
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
