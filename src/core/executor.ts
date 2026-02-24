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

// TONL (Token-Optimized Notation Language) formatters for component tools
// These reduce token usage by 40-60% compared to JSON for nested/repetitive structures

interface ComponentTreeNode {
    component: string;
    children?: ComponentTreeNode[];
    props?: Record<string, unknown>;
    layout?: Record<string, unknown>;
}

function formatTreeToTonl(node: ComponentTreeNode, indent = 0): string {
    const prefix = '  '.repeat(indent);
    let result = `${prefix}${node.component}`;

    // Add props inline if present
    if (node.props && Object.keys(node.props).length > 0) {
        const propsStr = Object.entries(node.props)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(',');
        result += ` (${propsStr})`;
    }

    // Add layout inline if present
    if (node.layout && Object.keys(node.layout).length > 0) {
        const layoutStr = Object.entries(node.layout)
            .map(([k, v]) => `${k}:${v}`)
            .join(',');
        result += ` [${layoutStr}]`;
    }

    result += '\n';

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
    const prefix = '  '.repeat(indent);
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
    layout?: Record<string, unknown>;
    text?: string;
    identifiers?: Record<string, string>;
}

function formatScreenLayoutToTonl(elements: ScreenElement[]): string {
    const lines: string[] = ['#elements{component,path,depth,layout,id}'];
    for (const el of elements) {
        const layout = el.layout ? Object.entries(el.layout).map(([k, v]) => `${k}:${v}`).join(';') : '';
        const id = el.identifiers?.testID || el.identifiers?.accessibilityLabel || '';
        lines.push(`${el.component}|${el.path}|${el.depth}|${layout}|${id}`);
    }
    return lines.join('\n');
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
    const lines: string[] = ['#found{component,path,depth,key,layout}'];
    for (const c of components) {
        const layout = c.layout ? Object.entries(c.layout).map(([k, v]) => `${k}:${v}`).join(';') : '';
        lines.push(`${c.component}|${c.path}|${c.depth}|${c.key || ''}|${layout}`);
    }
    return lines.join('\n');
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
    return lines.join('\n');
}

/**
 * Get the React component tree from the running app.
 * This traverses the fiber tree to extract component hierarchy with names.
 */
export async function getComponentTree(options: {
    maxDepth?: number;
    includeProps?: boolean;
    includeStyles?: boolean;
    hideInternals?: boolean;
    format?: 'json' | 'tonl';
    structureOnly?: boolean;
    focusedOnly?: boolean;
} = {}): Promise<ExecutionResult> {
    const { includeProps = false, includeStyles = false, hideInternals = true, format = 'tonl', structureOnly = false, focusedOnly = false } = options;
    // Use lower default depth for structureOnly to keep output compact (~2-5KB)
    // Full mode uses higher depth since TONL format handles it better
    // focusedOnly mode uses moderate depth since we're already filtering to active screen
    const maxDepth = options.maxDepth ?? (structureOnly ? (focusedOnly ? 25 : 40) : 100);

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

            // Find focused screen if requested
            function findFocusedScreen(fiber, depth = 0) {
                if (!fiber || depth > 200) return null;

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

    const result = await executeInApp(expression, false);

    // Apply formatting if requested
    if (result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.tree) {
                const prefix = parsed.focusedScreen ? `Focused: ${parsed.focusedScreen}\n\n` : '';

                // Structure-only mode: ultra-compact format with just component names
                if (structureOnly) {
                    const structure = formatTreeStructureOnly(parsed.tree);
                    return { success: true, result: prefix + structure };
                }
                // TONL format: compact with props/layout
                if (format === 'tonl') {
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
 * Get layout styles for all components on the current screen.
 * Useful for verifying layout without screenshots.
 */
export async function getScreenLayout(options: {
    maxDepth?: number;
    componentsOnly?: boolean;
    shortPath?: boolean;
    summary?: boolean;
    format?: 'json' | 'tonl';
} = {}): Promise<ExecutionResult> {
    const { maxDepth = 65, componentsOnly = false, shortPath = true, summary = false, format = 'tonl' } = options;

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
            const shortPath = ${shortPath};
            const summaryMode = ${summary};
            const pathSegments = 3; // Number of path segments to show in shortPath mode

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            function isHostComponent(fiber) {
                return typeof fiber?.type === 'string';
            }

            function formatPath(pathArray) {
                if (!shortPath || pathArray.length <= pathSegments) {
                    return pathArray.join(' > ');
                }
                return '... > ' + pathArray.slice(-pathSegments).join(' > ');
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
                        path: formatPath(path),
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

            // Summary mode: return counts by component name
            if (summaryMode) {
                const counts = {};
                for (const el of elements) {
                    counts[el.component] = (counts[el.component] || 0) + 1;
                }
                // Sort by count descending
                const sorted = Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => ({ component: name, count }));
                return {
                    totalElements: elements.length,
                    uniqueComponents: sorted.length,
                    components: sorted
                };
            }

            return {
                totalElements: elements.length,
                elements: elements
            };
        })()
    `;

    const result = await executeInApp(expression, false);

    // Apply TONL formatting if requested
    if (format === 'tonl' && result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.components) {
                // Summary mode
                const tonl = formatSummaryToTonl(parsed.components, parsed.totalElements);
                return { success: true, result: tonl };
            } else if (parsed.elements) {
                // Full element list
                const tonl = formatScreenLayoutToTonl(parsed.elements);
                return { success: true, result: tonl };
            }
        } catch {
            // If parsing fails, return original result
        }
    }

    return result;
}

/**
 * Inspect a specific component by name, returning its props, state, and layout.
 */
export async function inspectComponent(componentName: string, options: {
    index?: number;
    includeState?: boolean;
    includeChildren?: boolean;
    childrenDepth?: number;
    shortPath?: boolean;
    simplifyHooks?: boolean;
} = {}): Promise<ExecutionResult> {
    const { index = 0, includeState = true, includeChildren = false, childrenDepth = 1, shortPath = true, simplifyHooks = true } = options;
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
                // Simplified hook value serialization
                function serializeHookValue(val, depth = 0) {
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
                        result[k] = serializeHookValue(val[k], depth + 1);
                    }
                    return result;
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

    return executeInApp(expression, false);
}

/**
 * Find all components matching a name pattern and return summary info.
 */
export async function findComponents(pattern: string, options: {
    maxResults?: number;
    includeLayout?: boolean;
    shortPath?: boolean;
    summary?: boolean;
    format?: 'json' | 'tonl';
} = {}): Promise<ExecutionResult> {
    const { maxResults = 20, includeLayout = false, shortPath = true, summary = false, format = 'tonl' } = options;
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
                        path: formatPath(path),
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

            // Summary mode: just return counts by component name
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

    const result = await executeInApp(expression, false);

    // Apply TONL formatting if requested
    if (format === 'tonl' && result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.components) {
                if (parsed.totalMatches !== undefined) {
                    // Summary mode
                    const tonl = formatSummaryToTonl(parsed.components, parsed.totalMatches);
                    return { success: true, result: `pattern: ${parsed.pattern}\n${tonl}` };
                } else {
                    // Full list mode
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
export async function toggleElementInspector(): Promise<ExecutionResult> {
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

    return executeInApp(expression, false);
}

/**
 * Check if the Element Inspector overlay is currently active.
 */
export async function isInspectorActive(): Promise<boolean> {
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
                if (!fiber || depth > 100) return null;
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

    const result = await executeInApp(expression, false);
    if (result.success && result.result) {
        return result.result === 'true';
    }
    return false;
}

/**
 * Get the currently selected element from the Element Inspector overlay.
 * This reads the InspectorPanel component's props to get the hierarchy, frame, and style.
 * Requires the Element Inspector to be enabled and an element to be selected.
 */
export async function getInspectorSelection(): Promise<ExecutionResult> {
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

            // Find InspectorPanel component
            function findComponent(fiber, targetName, depth = 0) {
                if (!fiber || depth > 100) return null;
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

            const panelFiber = findComponent(roots[0].current, 'InspectorPanel');
            if (!panelFiber) {
                return {
                    error: 'Element Inspector is not active.',
                    hint: 'Use toggle_element_inspector to enable the inspector, then tap an element to select it.'
                };
            }

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

    return executeInApp(expression, false);
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
export async function inspectAtPoint(x: number, y: number, options: {
    includeProps?: boolean;
    includeFrame?: boolean;
} = {}): Promise<ExecutionResult> {
    const { includeProps = true, includeFrame = true } = options;

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

    const dispatchResult = await executeInApp(dispatchExpression, false);
    if (!dispatchResult.success) return dispatchResult;

    try {
        const parsed = JSON.parse(dispatchResult.result || '{}');
        if (parsed.error) return { success: false, error: parsed.error };
    } catch { /* ignore parse errors */ }

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
            var RN_PRIMITIVES = /^(View|Text|Image|ScrollView|FlatList|SectionList|TextInput|TouchableOpacity|TouchableHighlight|TouchableNativeFeedback|TouchableWithoutFeedback|Pressable|Button|Switch|ActivityIndicator|Modal|SafeAreaView|KeyboardAvoidingView|Animated\(.*|withAnimated.*|ForwardRef.*|memo\(.*|Context\.Consumer|Context\.Provider|VirtualizedList.*|CellRenderer.*|FrameSizeProvider|MaybeScreenContainer|RCT.*|RNS.*|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer)$/;

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

    return executeInApp(resolveExpression, false);
}
