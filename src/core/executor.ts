import WebSocket from "ws";
import { ExecutionResult } from "./types.js";
import { pendingExecutions, getNextMessageId, connectedApps } from "./state.js";
import { getFirstConnectedApp, connectToDevice } from "./connection.js";
import { fetchDevices, selectMainDevice } from "./metro.js";

// Hermes runtime compatibility: polyfill for 'global' which doesn't exist in Hermes
// In Hermes, globalThis is the standard way to access global scope
const GLOBAL_POLYFILL = `var global = typeof global !== 'undefined' ? global : globalThis;`;

// Execute JavaScript in the connected React Native app
export async function executeInApp(
    expression: string,
    awaitPromise: boolean = true
): Promise<ExecutionResult> {
    const app = getFirstConnectedApp();

    if (!app) {
        return { success: false, error: "No apps connected. Run 'scan_metro' first." };
    }

    if (app.ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: "WebSocket connection is not open." };
    }

    const TIMEOUT_MS = 10000;
    const currentMessageId = getNextMessageId();

    // Wrap expression with global polyfill for Hermes compatibility
    const wrappedExpression = `(function() { ${GLOBAL_POLYFILL} return (${expression}); })()`;

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            pendingExecutions.delete(currentMessageId);
            resolve({ success: false, error: "Timeout: Expression took too long to evaluate" });
        }, TIMEOUT_MS);

        pendingExecutions.set(currentMessageId, { resolve, timeoutId });

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
    });
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
    const app = getFirstConnectedApp();
    if (!app) {
        return { success: false, error: "No apps connected. Run 'scan_metro' first." };
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

        // Close existing connections to this port
        for (const [key, connectedApp] of connectedApps.entries()) {
            if (connectedApp.port === port) {
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

        // Reconnect to Metro on the same port
        const devices = await fetchDevices(port);
        const mainDevice = selectMainDevice(devices);

        if (mainDevice) {
            await connectToDevice(mainDevice, port);
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
