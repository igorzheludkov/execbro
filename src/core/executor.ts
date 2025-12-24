import WebSocket from "ws";
import { ExecutionResult } from "./types.js";
import { pendingExecutions, getNextMessageId } from "./state.js";
import { getFirstConnectedApp } from "./connection.js";

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
                    expression,
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
