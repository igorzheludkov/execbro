import WebSocket from "ws";
import type { ExecutionResult } from "./types.js";
import type { DeviceInfo } from "./types.js";
import { connectedApps, getNextMessageId } from "./state.js";
import { getConnectedAppByDevice, connectToDevice, clearReconnectionSuppression, purgeStaleConnectionsForPorts } from "./connection.js";
import { fetchDevices, filterDebuggableDevices, scanMetroPorts } from "./metro.js";
import { DEFAULT_RECONNECTION_CONFIG, cancelReconnectionTimer } from "./connectionState.js";
import { executeInApp, delay } from "./jsExecute.js";

// Build the IIFE expression used by listDebugGlobals. Exported so tests can
// assert structural invariants (e.g. that we probe __rn__, that we emit the
// expected hint) without needing to spin up a live CDP connection.
export function buildListDebugGlobalsExpression(): string {
    return `
        (function() {
            var names;
            try {
                var enumNames = Object.keys(globalThis);
                var ownNames = Object.getOwnPropertyNames(globalThis);
                var seen = {};
                names = [];
                for (var i = 0; i < ownNames.length; i++) { if (!seen[ownNames[i]]) { seen[ownNames[i]] = 1; names.push(ownNames[i]); } }
                for (var j = 0; j < enumNames.length; j++) { if (!seen[enumNames[j]]) { seen[enumNames[j]] = 1; names.push(enumNames[j]); } }
            } catch (e) {
                names = Object.keys(globalThis);
            }

            var categories = {
                'Apollo Client': [],
                'Redux': [],
                'React DevTools': [],
                'Reanimated': [],
                'Expo': [],
                'Metro': [],
                'Other Debug': []
            };
            for (var k = 0; k < names.length; k++) {
                var key = names[k];
                if (key.indexOf('APOLLO') >= 0) categories['Apollo Client'].push(key);
                else if (key.indexOf('REDUX') >= 0) categories['Redux'].push(key);
                else if (key.indexOf('REACT_DEVTOOLS') >= 0) categories['React DevTools'].push(key);
                else if (key.indexOf('reanimated') >= 0 || key.indexOf('worklet') >= 0) categories['Reanimated'].push(key);
                else if (key.indexOf('Expo') >= 0 || key.indexOf('expo') >= 0) categories['Expo'].push(key);
                else if (key.indexOf('METRO') >= 0) categories['Metro'].push(key);
                else if (key.indexOf('__') === 0) categories['Other Debug'].push(key);
            }

            // SDK probe: detect __RN_AI_DEVTOOLS__ even when not enumerable on
            // globalThis, and flatten its registered objects into dotted paths
            // the agent can hand straight to inspect_global / execute_in_app.
            var sdk = null;
            try {
                if (typeof globalThis.__RN_AI_DEVTOOLS__ !== 'undefined' && globalThis.__RN_AI_DEVTOOLS__) {
                    var dt = globalThis.__RN_AI_DEVTOOLS__;
                    var paths = [];
                    // Map well-known store keys back into the legacy category
                    // buckets so SDK-registered stores don't appear missing to
                    // agents that scan categories.Redux / categories["Apollo Client"].
                    var storeCategory = {
                        redux: 'Redux',
                        apollo: 'Apollo Client',
                        apolloclient: 'Apollo Client',
                        reactdevtools: 'React DevTools'
                    };
                    if (dt.stores && typeof dt.stores === 'object') {
                        var sk = Object.keys(dt.stores);
                        for (var a = 0; a < sk.length; a++) {
                            var storeKey = sk[a];
                            var path = '__RN_AI_DEVTOOLS__.stores.' + storeKey;
                            paths.push(path);
                            var bucket = storeCategory[storeKey.toLowerCase()];
                            if (bucket && categories[bucket].indexOf(path) < 0) {
                                categories[bucket].push(path);
                            }
                        }
                    }
                    if (dt.navigation) paths.push('__RN_AI_DEVTOOLS__.navigation');
                    if (dt.custom && typeof dt.custom === 'object') {
                        var ck = Object.keys(dt.custom);
                        for (var b = 0; b < ck.length; b++) paths.push('__RN_AI_DEVTOOLS__.custom.' + ck[b]);
                    }
                    sdk = {
                        version: dt.version || 'unknown',
                        capabilities: dt.capabilities || null,
                        paths: paths,
                        hint: 'These paths are inspect_global / execute_in_app ready (dotted paths supported).'
                    };
                    // Make sure the root global also appears in the listing,
                    // even if Hermes hid it from Object.keys.
                    if (categories['Other Debug'].indexOf('__RN_AI_DEVTOOLS__') < 0) {
                        categories['Other Debug'].push('__RN_AI_DEVTOOLS__');
                    }
                }
            } catch (e) { /* ignore */ }

            // RN namespace probe: populated by the SDK's exposeRnGlobals() or
            // the executor's fallback fiber-walk bootstrap. Reports keys when
            // available so agents discover the namespace without reading docs.
            //   undefined -> bootstrap not run yet
            //   null      -> bootstrap attempted, no modules found
            //   object    -> populated namespace
            var rn = null;
            try {
                var rnRaw = globalThis.__rn__;
                if (typeof rnRaw === 'undefined') {
                    rn = null;
                } else if (rnRaw === null) {
                    rn = {
                        keys: [],
                        hint: 'Bootstrap attempted but no fiber had the curated RN modules in scope. Install react-native-ai-devtools-sdk or fall back to a fiber walk.'
                    };
                    if (categories['Other Debug'].indexOf('__rn__') < 0) {
                        categories['Other Debug'].push('__rn__');
                    }
                } else if (typeof rnRaw === 'object') {
                    var rnKeys = Object.keys(rnRaw);
                    rn = {
                        keys: rnKeys,
                        hint: 'Use globalThis.__rn__.<Module> (e.g. globalThis.__rn__.I18nManager.isRTL) in execute_in_app, or pass dotted paths like __rn__.Platform to inspect_global.'
                    };
                    if (categories['Other Debug'].indexOf('__rn__') < 0) {
                        categories['Other Debug'].push('__rn__');
                    }
                }
            } catch (e) { /* ignore */ }

            return { sdk: sdk, rn: rn, categories: categories };
        })()
    `;
}

// List globally available debugging objects in the app.
// Uses Object.getOwnPropertyNames + Object.keys to catch non-enumerable globals
// (Hermes does not always make `globalThis.x = ...` assignments enumerable),
// and probes __RN_AI_DEVTOOLS__ directly so the SDK's registered stores/
// navigation/custom objects surface as ready-to-use dotted paths.
export async function listDebugGlobals(device?: string): Promise<ExecutionResult> {
    return executeInApp(buildListDebugGlobalsExpression(), false, { originatingToolName: "list_debug_globals" }, device);
}

// Inspect a global object (or a dotted path into one) to see its properties
// and types. Accepts plain identifiers (`__APOLLO_CLIENT__`) and dotted paths
// (`__RN_AI_DEVTOOLS__.stores.redux`) so the discovery output from
// listDebugGlobals can be passed straight back in.
export async function inspectGlobal(objectName: string, device?: string): Promise<ExecutionResult> {
    // Reject anything that isn't a safe dotted identifier path. This both
    // prevents accidental code execution via objectName and produces a clear
    // error instead of a confusing Hermes parse failure.
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(objectName)) {
        return {
            success: false,
            error: `Invalid objectName: '${objectName}'. Expected an identifier or dotted path like '__APOLLO_CLIENT__' or '__RN_AI_DEVTOOLS__.stores.redux'. For arbitrary expressions, use execute_in_app.`
        };
    }

    const expression = `
        (function() {
            var obj;
            try { obj = ${objectName}; } catch (e) { return { error: 'NotFound: ' + (e && e.message ? e.message : String(e)) }; }
            if (obj === undefined) return { error: 'Object not found' };
            if (obj === null) return { error: 'Value is null' };
            var t = typeof obj;
            if (t !== 'object' && t !== 'function') {
                return { __value: obj, __type: t };
            }
            var result = {};
            var keys;
            try { keys = Object.keys(obj); } catch (e) { keys = []; }
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                var val;
                try { val = obj[key]; } catch (e) { result[key] = { type: 'unknown', callable: false, error: 'getter threw' }; continue; }
                var type = typeof val;
                if (type === 'function') {
                    result[key] = { type: 'function', callable: true };
                } else if (type === 'object' && val !== null) {
                    var preview;
                    try { preview = JSON.stringify(val); } catch (e) { preview = '[unserializable]'; }
                    if (preview && preview.length > 100) preview = preview.slice(0, 100) + '...';
                    result[key] = { type: Array.isArray(val) ? 'array' : 'object', callable: false, preview: preview };
                } else {
                    result[key] = { type: type, callable: false, value: val };
                }
            }
            return result;
        })()
    `;

    return executeInApp(expression, false, { originatingToolName: "inspect_global" }, device);
}

// Reload the React Native app using __ReactRefresh
// Note: Page.reload CDP method may work on Bridgeless targets (via HostAgent) — not yet tested
// Uses fire-and-forget: sends the reload command without waiting for a response,
// since the JS context is destroyed during reload and would always timeout.
export async function reloadApp(device?: string): Promise<ExecutionResult> {
    // Get current connection info before reload
    let app = getConnectedAppByDevice(device);

    // Auto-connect if no connection exists. Mirrors scan_metro's flow
    // (clearReconnectionSuppression + filterDebuggableDevices + purge +
    // connectToDevice per device) — earlier attempts that used ensureConnection
    // here raced with WS close events on first connect and reported
    // "Connection succeeded but app is not available". scan_metro's pattern
    // is the empirically-stable path.
    if (!app) {
        console.error("[execbro] No connection for reload, attempting auto-connect...");

        const ports = await scanMetroPorts();
        if (ports.length === 0) {
            return {
                success: false,
                error: "No apps connected and no Metro server found. Make sure Metro bundler is running (npm start or expo start), then try again."
            };
        }

        clearReconnectionSuppression();

        const portDevices = new Map<number, DeviceInfo[]>();
        for (const port of ports) {
            const devices = await fetchDevices(port);
            const debuggable = filterDebuggableDevices(devices);
            if (debuggable.length > 0) {
                portDevices.set(port, debuggable);
            }
        }

        purgeStaleConnectionsForPorts(portDevices);

        for (const [port, devices] of portDevices) {
            for (const dev of devices) {
                try {
                    await connectToDevice(dev, port);
                } catch (error) {
                    console.error(`[execbro] Auto-connect failed for ${dev.title} on port ${port}: ${error}`);
                }
            }
        }

        app = getConnectedAppByDevice(device);
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
