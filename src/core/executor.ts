import WebSocket from "ws";
import { ExecutionResult, ExecuteOptions } from "./types.js";
import { pendingExecutions, getNextMessageId, connectedApps } from "./state.js";
import { getFirstConnectedApp, connectToDevice } from "./connection.js";
import { fetchDevices, selectMainDevice, scanMetroPorts } from "./metro.js";
import { DEFAULT_RECONNECTION_CONFIG, cancelReconnectionTimer } from "./connectionState.js";

// Hermes runtime compatibility: polyfill for 'global' which doesn't exist in Hermes
// In Hermes, globalThis is the standard way to access global scope
const GLOBAL_POLYFILL = `var global = typeof global !== 'undefined' ? global : globalThis;`;

// ============================================================================
// Expression Preprocessing & Validation
// ============================================================================

interface ExpressionValidation {
    valid: boolean;
    expression: string;
    error?: string;
}

/**
 * Check if a string contains emoji or other problematic Unicode characters
 * Hermes has issues with certain UTF-16 surrogate pairs (like emoji)
 */
function containsProblematicUnicode(str: string): boolean {
    // Detect UTF-16 surrogate pairs (emoji and other characters outside BMP)
    // These cause "Invalid UTF-8 code point" errors in Hermes
    // eslint-disable-next-line no-control-regex
    return /[\uD800-\uDFFF]/.test(str);
}

/**
 * Strip leading comments from an expression
 * Users often start with // comments which break the (return expr) wrapping
 */
function stripLeadingComments(expression: string): string {
    let result = expression;

    // Strip leading whitespace first
    result = result.trimStart();

    // Repeatedly strip leading single-line comments (// ...)
    while (result.startsWith('//')) {
        const newlineIndex = result.indexOf('\n');
        if (newlineIndex === -1) {
            // Entire expression is a comment
            return '';
        }
        result = result.slice(newlineIndex + 1).trimStart();
    }

    // Strip leading multi-line comments (/* ... */)
    while (result.startsWith('/*')) {
        const endIndex = result.indexOf('*/');
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
function validateAndPreprocessExpression(expression: string): ExpressionValidation {
    // Check for emoji/problematic Unicode before any processing
    if (containsProblematicUnicode(expression)) {
        return {
            valid: false,
            expression,
            error: "Expression contains emoji or special Unicode characters that Hermes cannot compile. " +
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
    if (trimmed.startsWith('(async') || trimmed.startsWith('async ') || trimmed.startsWith('async(')) {
        return {
            valid: false,
            expression: cleaned,
            error: "Hermes does not support top-level async functions in Runtime.evaluate. " +
                   "Instead of `(async () => { ... })()`, use a synchronous approach or " +
                   "execute the async code and access the result via a global variable: " +
                   "`global.__result = null; myAsyncFn().then(r => global.__result = r)`"
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
    awaitPromise: boolean
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
    const TIMEOUT_MS = 10000;
    const currentMessageId = getNextMessageId();

    // Wrap expression with global polyfill for Hermes compatibility
    const wrappedExpression = `(function() { ${GLOBAL_POLYFILL} return (${cleanedExpression}); })()`;

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            pendingExecutions.delete(currentMessageId);
            resolve({ success: false, error: "Timeout: Expression took too long to evaluate" });
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
                        generatePreview: true,
                    },
                })
            );
        } catch (error) {
            clearTimeout(timeoutId);
            pendingExecutions.delete(currentMessageId);
            resolve({
                success: false,
                error: `Failed to send: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    });
}

// Execute JavaScript in the connected React Native app with retry logic
export async function executeInApp(
    expression: string,
    awaitPromise: boolean = true,
    options: ExecuteOptions = {}
): Promise<ExecutionResult> {
    const { maxRetries = 2, retryDelayMs = 1000, autoReconnect = true } = options;

    let lastError: string | undefined;
    let preferredPort: number | undefined;

    // Get preferred port from current connection if available
    const currentApp = getFirstConnectedApp();
    if (currentApp) {
        preferredPort = currentApp.port;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const app = getFirstConnectedApp();

        // No connection - try to reconnect if enabled
        if (!app) {
            if (autoReconnect && attempt < maxRetries) {
                console.error(`[rn-ai-debugger] No connection, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`);
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
                console.error(`[rn-ai-debugger] WebSocket not open, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`);
                // Close stale connection
                const appKey = `${app.port}-${app.deviceInfo.id}`;
                cancelReconnectionTimer(appKey);
                try { app.ws.close(); } catch { /* ignore */ }
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
        const result = await executeExpressionCore(expression, awaitPromise);

        // Success - return result
        if (result.success) {
            return result;
        }

        lastError = result.error;

        // Check if this is a context error that might be recoverable
        if (isContextError(result.error)) {
            if (autoReconnect && attempt < maxRetries) {
                console.error(`[rn-ai-debugger] Context error detected, attempting reconnect (attempt ${attempt + 1}/${maxRetries})...`);

                // Close and reconnect
                const appKey = `${app.port}-${app.deviceInfo.id}`;
                cancelReconnectionTimer(appKey);
                try { app.ws.close(); } catch { /* ignore */ }
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
        error: lastError ?? "Execution failed after all retries. Connection may be stale.",
    };
}

// List globally available debugging objects in the app
export async function listDebugGlobals(): Promise<ExecutionResult> {
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

    return executeInApp(expression, false);
}

// Inspect a global object to see its properties and types
export async function inspectGlobal(objectName: string): Promise<ExecutionResult> {
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

    return executeInApp(expression, false);
}

// Reload the React Native app using __ReactRefresh (Page.reload is not supported by Hermes)
export async function reloadApp(): Promise<ExecutionResult> {
    // Get current connection info before reload
    let app = getFirstConnectedApp();

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
                    app = getFirstConnectedApp();
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

    // Use __ReactRefresh.performFullRefresh() which is available in Metro bundler dev mode
    // This works with Hermes unlike the CDP Page.reload method
    const expression = `
        (function() {
            try {
                // Use React Refresh's full refresh - most reliable method
                if (typeof __ReactRefresh !== 'undefined' && typeof __ReactRefresh.performFullRefresh === 'function') {
                    __ReactRefresh.performFullRefresh('mcp-reload');
                    return 'Reload triggered via __ReactRefresh.performFullRefresh';
                }
                // Fallback: Try DevSettings if available on global
                if (typeof global !== 'undefined' && global.DevSettings && typeof global.DevSettings.reload === 'function') {
                    global.DevSettings.reload();
                    return 'Reload triggered via DevSettings';
                }
                return 'Reload not available - make sure app is in development mode with Metro bundler';
            } catch (e) {
                return 'Reload failed: ' + e.message;
            }
        })()
    `;

    const result = await executeInApp(expression, false);

    if (!result.success) {
        return result;
    }

    // Auto-reconnect after reload
    try {
        // Wait for app to reload (give it time to restart JS context)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Close existing connections to this port and cancel any pending auto-reconnections
        // This prevents the dual-reconnection bug where both auto-reconnect and manual reconnect compete
        for (const [key, connectedApp] of connectedApps.entries()) {
            if (connectedApp.port === port) {
                // Cancel any pending reconnection timer BEFORE closing
                cancelReconnectionTimer(key);
                try {
                    connectedApp.ws.close();
                } catch {
                    // Ignore close errors
                }
                connectedApps.delete(key);
            }
        }

        // Small delay to ensure cleanup
        await new Promise(resolve => setTimeout(resolve, 500));

        // Reconnect to Metro on the same port with auto-reconnection DISABLED
        // We're doing a manual reconnection here, so we don't want the auto-reconnect
        // system to also try reconnecting and compete with us
        const devices = await fetchDevices(port);
        const mainDevice = selectMainDevice(devices);

        if (mainDevice) {
            await connectToDevice(mainDevice, port, {
                isReconnection: false,
                reconnectionConfig: { ...DEFAULT_RECONNECTION_CONFIG, enabled: false }
            });
            return {
                success: true,
                result: `App reloaded and reconnected to ${mainDevice.title}`
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

/**
 * Get the React component tree from the running app.
 * This traverses the fiber tree to extract component hierarchy with names.
 */
export async function getComponentTree(options: {
    maxDepth?: number;
    includeProps?: boolean;
    includeStyles?: boolean;
} = {}): Promise<ExecutionResult> {
    const { maxDepth = 20, includeProps = false, includeStyles = false } = options;

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

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type; // Host component (View, Text, etc.)
                return fiber.type.displayName || fiber.type.name || null;
            }

            function extractLayoutStyles(style) {
                if (!style) return null;
                const merged = Array.isArray(style)
                    ? Object.assign({}, ...style.filter(Boolean).map(s => typeof s === 'object' ? s : {}))
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
            }

            function walkFiber(fiber, depth) {
                if (!fiber || depth > maxDepth) return null;

                const name = getComponentName(fiber);

                // Skip anonymous/internal components unless they have meaningful children
                if (!name) {
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
                        const val = fiber.memoizedProps[key];
                        if (typeof val === 'function') {
                            props[key] = '[Function]';
                        } else if (typeof val === 'object' && val !== null) {
                            props[key] = Array.isArray(val) ? '[Array]' : '[Object]';
                        } else {
                            props[key] = val;
                        }
                    }
                    if (Object.keys(props).length > 0) node.props = props;
                }

                // Include layout styles if requested
                if (includeStyles && fiber.memoizedProps?.style) {
                    const layout = extractLayoutStyles(fiber.memoizedProps.style);
                    if (layout) node.layout = layout;
                }

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

            const tree = walkFiber(roots[0].current, 0);
            return { tree };
        })()
    `;

    return executeInApp(expression, false);
}

/**
 * Get layout styles for all components on the current screen.
 * Useful for verifying layout without screenshots.
 */
export async function getScreenLayout(options: {
    maxDepth?: number;
    componentsOnly?: boolean;
} = {}): Promise<ExecutionResult> {
    const { maxDepth = 30, componentsOnly = false } = options;

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

            const maxDepth = ${maxDepth};
            const componentsOnly = ${componentsOnly};

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            function isHostComponent(fiber) {
                return typeof fiber?.type === 'string';
            }

            function extractAllStyles(style) {
                if (!style) return null;
                const merged = Array.isArray(style)
                    ? Object.assign({}, ...style.filter(Boolean).map(s => typeof s === 'object' ? s : {}))
                    : (typeof style === 'object' ? style : {});
                return Object.keys(merged).length > 0 ? merged : null;
            }

            function extractLayoutStyles(style) {
                if (!style) return null;
                const merged = Array.isArray(style)
                    ? Object.assign({}, ...style.filter(Boolean).map(s => typeof s === 'object' ? s : {}))
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
                    'borderWidth', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth',
                    'backgroundColor', 'borderColor', 'borderRadius'
                ];

                for (const key of layoutKeys) {
                    if (merged[key] !== undefined) layout[key] = merged[key];
                }
                return Object.keys(layout).length > 0 ? layout : null;
            }

            const elements = [];

            function walkFiber(fiber, depth, path) {
                if (!fiber || depth > maxDepth) return;

                const name = getComponentName(fiber);
                const isHost = isHostComponent(fiber);

                // Include host components (View, Text, etc.) or named components
                if (name && (!componentsOnly || !isHost)) {
                    const style = fiber.memoizedProps?.style;
                    const layout = extractLayoutStyles(style);

                    // Get text content if it's a Text component
                    let textContent = null;
                    if (name === 'Text' || name === 'RCTText') {
                        const children = fiber.memoizedProps?.children;
                        if (typeof children === 'string') textContent = children;
                        else if (typeof children === 'number') textContent = String(children);
                    }

                    const element = {
                        component: name,
                        path: path.join(' > '),
                        depth
                    };

                    if (layout) element.layout = layout;
                    if (textContent) element.text = textContent.slice(0, 100);

                    // Include key props for identification
                    if (fiber.memoizedProps) {
                        const identifiers = {};
                        if (fiber.memoizedProps.testID) identifiers.testID = fiber.memoizedProps.testID;
                        if (fiber.memoizedProps.accessibilityLabel) identifiers.accessibilityLabel = fiber.memoizedProps.accessibilityLabel;
                        if (fiber.memoizedProps.nativeID) identifiers.nativeID = fiber.memoizedProps.nativeID;
                        if (fiber.key) identifiers.key = fiber.key;
                        if (Object.keys(identifiers).length > 0) element.identifiers = identifiers;
                    }

                    elements.push(element);
                }

                // Traverse children
                let child = fiber.child;
                while (child) {
                    const childName = getComponentName(child);
                    walkFiber(child, depth + 1, childName ? [...path, childName] : path);
                    child = child.sibling;
                }
            }

            walkFiber(roots[0].current, 0, []);

            return {
                totalElements: elements.length,
                elements: elements
            };
        })()
    `;

    return executeInApp(expression, false);
}

/**
 * Inspect a specific component by name, returning its props, state, and layout.
 */
export async function inspectComponent(componentName: string, options: {
    index?: number;
    includeState?: boolean;
    includeChildren?: boolean;
} = {}): Promise<ExecutionResult> {
    const { index = 0, includeState = true, includeChildren = false } = options;
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

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            function extractStyles(style) {
                if (!style) return null;
                const merged = Array.isArray(style)
                    ? Object.assign({}, ...style.filter(Boolean).map(s => typeof s === 'object' ? s : {}))
                    : (typeof style === 'object' ? style : {});
                return Object.keys(merged).length > 0 ? merged : null;
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
                    result[k] = serializeValue(val[k], depth + 1);
                }
                return result;
            }

            function getChildNames(fiber) {
                const names = [];
                let child = fiber?.child;
                while (child && names.length < 20) {
                    const name = getComponentName(child);
                    if (name) names.push(name);
                    child = child.sibling;
                }
                return names;
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
                path: path.join(' > '),
                instancesFound: matches.length,
                instanceIndex: targetIndex
            };

            // Props (excluding children)
            if (fiber.memoizedProps) {
                const props = {};
                for (const key of Object.keys(fiber.memoizedProps)) {
                    if (key === 'children') continue;
                    props[key] = serializeValue(fiber.memoizedProps[key]);
                }
                result.props = props;
            }

            // Style separately for clarity
            if (fiber.memoizedProps?.style) {
                result.style = extractStyles(fiber.memoizedProps.style);
            }

            // State (for hooks, this is a linked list)
            if (includeState && fiber.memoizedState) {
                // For function components with hooks
                const states = [];
                let state = fiber.memoizedState;
                let hookIndex = 0;
                while (state && hookIndex < 20) {
                    if (state.memoizedState !== undefined) {
                        states.push({
                            hookIndex,
                            value: serializeValue(state.memoizedState)
                        });
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

            // Direct children names
            if (includeChildren) {
                result.children = getChildNames(fiber);
            }

            return result;
        })()
    `;

    return executeInApp(expression, false);
}

/**
 * Find all components matching a name pattern and return summary info.
 */
export async function findComponents(pattern: string, options: {
    maxResults?: number;
    includeLayout?: boolean;
} = {}): Promise<ExecutionResult> {
    const { maxResults = 50, includeLayout = false } = options;
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

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            function extractLayoutStyles(style) {
                if (!style) return null;
                const merged = Array.isArray(style)
                    ? Object.assign({}, ...style.filter(Boolean).map(s => typeof s === 'object' ? s : {}))
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
            }

            const results = [];

            function search(fiber, path, depth) {
                if (!fiber || results.length >= maxResults) return;

                const name = getComponentName(fiber);
                if (name && regex.test(name)) {
                    const entry = {
                        component: name,
                        path: path.join(' > '),
                        depth
                    };

                    if (fiber.memoizedProps?.testID) entry.testID = fiber.memoizedProps.testID;
                    if (fiber.key) entry.key = fiber.key;

                    if (includeLayout && fiber.memoizedProps?.style) {
                        const layout = extractLayoutStyles(fiber.memoizedProps.style);
                        if (layout) entry.layout = layout;
                    }

                    results.push(entry);
                }

                let child = fiber.child;
                while (child && results.length < maxResults) {
                    const childName = getComponentName(child);
                    search(child, childName ? [...path, childName] : path, depth + 1);
                    child = child.sibling;
                }
            }

            search(roots[0].current, [], 0);

            return {
                pattern,
                found: results.length,
                components: results
            };
        })()
    `;

    return executeInApp(expression, false);
}
