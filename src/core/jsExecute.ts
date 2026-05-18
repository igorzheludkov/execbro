import WebSocket from "ws";
import { ExecutionResult, ExecuteOptions } from "./types.js";
import { escapeNonAsciiInStringLiterals } from "./escapeNonAscii.js";
import { pendingExecutions, getNextMessageId, connectedApps } from "./state.js";
import { getFirstConnectedApp, getConnectedAppByDevice, getConnectedAppBySimulatorUdid, getConnectedAppByAndroidDeviceId, connectToDevice, clearReconnectionSuppression, purgeStaleConnectionsForPorts } from "./connection.js";
import { fetchDevices, selectMainDevice, filterDebuggableDevices, scanMetroPorts } from "./metro.js";
import type { DeviceInfo } from "./types.js";
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
 * @deprecated retained for backward compatibility — escapeNonAsciiInStringLiterals handles this now.
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
    // Strip leading comments that would break the expression wrapper
    const cleaned = stripLeadingComments(expression);

    if (!cleaned.trim()) {
        return {
            valid: false,
            expression,
            error: "Expression is empty or contains only comments."
        };
    }

    // Auto-escape non-ASCII inside string literals so the wire stays ASCII
    // and Hermes can compile the expression.
    const escapeResult = escapeNonAsciiInStringLiterals(cleaned);
    if (!escapeResult.ok) {
        return {
            valid: false,
            expression: cleaned,
            error:
                "Unable to auto-escape non-ASCII characters in expression: " +
                escapeResult.reason +
                ". Replace non-ASCII characters with \\uXXXX escape sequences and retry, or check for unbalanced quotes."
        };
    }
    const escaped = escapeResult.expression;

    // Check for top-level async/await that Hermes doesn't support in Runtime.evaluate
    const trimmed = escaped.trim();
    if (looksLikeTopLevelAwait(trimmed)) {
        return {
            valid: false,
            expression: escaped,
            error:
                "top-level await is not supported in Hermes. " +
                "Wrap in `Promise.resolve().then(v => ...)` instead, or assign the resolved value to a global: " +
                "`global.__result = null; myAsyncFn().then(r => global.__result = r)`."
        };
    }

    // Check for require() calls that don't work in Hermes Runtime.evaluate
    if (/\brequire\s*\(/.test(trimmed)) {
        return {
            valid: false,
            expression: escaped,
            error:
                "require() is not available in Hermes Runtime.evaluate. " +
                "Modules cannot be imported at runtime. Only pre-existing global variables are accessible. " +
                "Use list_debug_globals to discover available globals, or add `globalThis.__MY_VAR__ = myModule;` in your app code."
        };
    }

    // Check for multi-statement expressions. Runtime.evaluate compiles input as
    // a single expression — `console.log('x'); 1+1` raises `')' expected at end
    // of parenthesized expression`. Internal callers wrap in (function(){...})()
    // so any `;` they use is at brace depth 1 and won't be flagged.
    if (hasTopLevelStatementSeparator(trimmed)) {
        return {
            valid: false,
            expression: escaped,
            error:
                "Multi-statement expressions are not supported by Hermes Runtime.evaluate " +
                "(compiles input as a single expression). " +
                "Wrap the body in an IIFE: `(function(){ stmt1; stmt2; return result; })()`."
        };
    }

    return {
        valid: true,
        expression: escaped
    };
}

function isIdentChar(c: string | undefined): boolean {
    return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

// Detect top-level `await`, `async function`, `async (...) => ...`, or
// `(async ...)` IIFE forms in `src`. Walks char-by-char tracking string,
// template, comment, and bracket depth so we don't false-positive on
// substrings inside strings, identifiers like `awaiting`, etc.
function looksLikeTopLevelAwait(src: string): boolean {
    // Cheap prefix checks for async-function / async-arrow / async-IIFE forms.
    // Whitespace-tolerant on `async <keyword>` / `async (`.
    const asyncPrefix = /^async\s*(?:function\b|\()/;
    if (asyncPrefix.test(src)) return true;
    // `(async () => ...)()` or `(async(...)...)` — match `(async` followed by
    // a non-identifier char (so `(asyncFoo` doesn't trigger).
    const parenAsync = /^\(\s*async(?:\s|\()/;
    if (parenAsync.test(src)) return true;

    // Depth-tracked scan for a standalone `await` token at depth 0.
    let i = 0;
    let parens = 0;
    let braces = 0;
    let brackets = 0;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (ch === "/" && next === "/") {
            const nl = src.indexOf("\n", i + 2);
            if (nl === -1) return false;
            i = nl + 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            const end = src.indexOf("*/", i + 2);
            if (end === -1) return false;
            i = end + 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch;
            i++;
            while (i < src.length) {
                if (src[i] === "\\") { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        if (ch === "(") { parens++; i++; continue; }
        if (ch === ")") { parens--; i++; continue; }
        if (ch === "{") { braces++; i++; continue; }
        if (ch === "}") { braces--; i++; continue; }
        if (ch === "[") { brackets++; i++; continue; }
        if (ch === "]") { brackets--; i++; continue; }

        if (
            parens === 0 && braces === 0 && brackets === 0 &&
            ch === "a" &&
            src.slice(i, i + 5) === "await" &&
            !isIdentChar(src[i - 1]) &&
            !isIdentChar(src[i + 5])
        ) {
            return true;
        }
        i++;
    }
    return false;
}

// Walk `src` tracking string/template/comment and bracket depth. Returns true
// iff a `;` appears at depth 0 with non-whitespace following it (i.e. it
// separates two top-level statements rather than terminating a single one).
function hasTopLevelStatementSeparator(src: string): boolean {
    let i = 0;
    let parens = 0;
    let braces = 0;
    let brackets = 0;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (ch === "/" && next === "/") {
            const nl = src.indexOf("\n", i + 2);
            if (nl === -1) return false;
            i = nl + 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            const end = src.indexOf("*/", i + 2);
            if (end === -1) return false;
            i = end + 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch;
            i++;
            while (i < src.length) {
                if (src[i] === "\\") { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        if (ch === "(") parens++;
        else if (ch === ")") parens--;
        else if (ch === "{") braces++;
        else if (ch === "}") braces--;
        else if (ch === "[") brackets++;
        else if (ch === "]") brackets--;
        else if (ch === ";" && parens === 0 && braces === 0 && brackets === 0) {
            const rest = src.slice(i + 1).trim();
            if (rest.length > 0) return true;
        }
        i++;
    }
    return false;
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
export function delay(ms: number): Promise<void> {
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
    timeoutMs: number = 10000,
    targetApp?: ReturnType<typeof getFirstConnectedApp>
): Promise<ExecutionResult> {
    const app = targetApp ?? getFirstConnectedApp();

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
    const { maxRetries = 2, retryDelayMs = 1000, autoReconnect = true, timeoutMs = 10000, skipBootstrap = false } = options;

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
                    `[execbro] No connection, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`
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
                    `[execbro] WebSocket not open, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`
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

        // Best-effort one-shot bootstrap of globalThis.__rn__ for this app
        // session. Hermes does not expose closure-captured RN modules, so this
        // fiber-walk usually sets __rn__ = null — that's fine; list_debug_globals
        // reports the failure clearly. Wrapped in try/catch so a bootstrap
        // failure never breaks the user's expression. skipBootstrap is set by
        // the bootstrap itself (via ensureRnGlobalsBootstrap) to avoid recursion.
        if (!skipBootstrap) {
            try {
                const { ensureRnGlobalsBootstrap } = await import("./rnGlobalsBootstrap.js");
                await ensureRnGlobalsBootstrap(device);
            } catch (e) {
                console.error("[execbro] __rn__ bootstrap dispatch failed:", e);
            }
        }

        // Execute the expression
        const result = await executeExpressionCore(expression, awaitPromise, timeoutMs, app);

        // Success - return result
        if (result.success) {
            return result;
        }

        lastError = result.error;

        // Check if this is a context error that might be recoverable
        if (isContextError(result.error)) {
            if (autoReconnect && attempt < maxRetries) {
                console.error(
                    `[execbro] Context error detected, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`
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
