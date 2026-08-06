import WebSocket from "ws";
import type { ExecutionResult } from "./types.js";
import type { DeviceInfo } from "./types.js";
import { connectedApps, getNextMessageId } from "./state.js";
import { resolveConnectedAppByDevice, describeDeviceResolution, connectToDevice, clearReconnectionSuppression, purgeStaleConnectionsForPorts } from "./connection.js";
import { fetchDevices, filterDebuggableDevices, scanMetroPorts } from "./metro.js";
import { DEFAULT_RECONNECTION_CONFIG, cancelReconnectionTimer } from "./connectionState.js";
import { executeInApp, delay } from "./jsExecute.js";
import { isSDKInstalled } from "./sdkBridge.js";
import { mirrorOnce } from "./sdkMirrorPoller.js";

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
                var _sdkRoot = globalThis.__EXECBRO__ || globalThis.__RN_AI_DEVTOOLS__;
                if (typeof _sdkRoot !== 'undefined' && _sdkRoot) {
                    var rootName = typeof globalThis.__EXECBRO__ !== 'undefined' ? '__EXECBRO__' : '__RN_AI_DEVTOOLS__';
                    var dt = _sdkRoot;
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
                            var path = rootName + '.stores.' + storeKey;
                            paths.push(path);
                            var bucket = storeCategory[storeKey.toLowerCase()];
                            if (bucket && categories[bucket].indexOf(path) < 0) {
                                categories[bucket].push(path);
                            }
                        }
                    }
                    if (dt.navigation) paths.push(rootName + '.navigation');
                    if (dt.custom && typeof dt.custom === 'object') {
                        var ck = Object.keys(dt.custom);
                        for (var b = 0; b < ck.length; b++) paths.push(rootName + '.custom.' + ck[b]);
                    }
                    sdk = {
                        version: dt.version || 'unknown',
                        capabilities: dt.capabilities || null,
                        paths: paths,
                        hint: 'These paths are inspect_global / execute_in_app ready (dotted paths supported).'
                    };
                    // Make sure both root globals appear in the listing,
                    // even if Hermes hid them from Object.keys.
                    if (categories['Other Debug'].indexOf('__EXECBRO__') < 0) {
                        categories['Other Debug'].push('__EXECBRO__');
                    }
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
                        hint: 'Bootstrap attempted but no fiber had the curated RN modules in scope. Install execbro-sdk or fall back to a fiber walk.'
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
            error: `Invalid objectName: '${objectName}'. Expected an identifier or dotted path like '__APOLLO_CLIENT__' or '__EXECBRO__.stores.redux'. For arbitrary expressions, use execute_in_app.`
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

// Metro's /json/list can lag a freshly launched app; how long to wait before
// the single auto-connect retry inside reloadApp.
const AUTO_CONNECT_RETRY_DELAY_MS = 1200;

// Reload the React Native app using __ReactRefresh
// Note: Page.reload CDP method may work on Bridgeless targets (via HostAgent) — not yet tested
// Uses fire-and-forget: sends the reload command without waiting for a response,
// since the JS context is destroyed during reload and would always timeout.
// One auto-connect sweep over every Metro port: mirrors scan_metro's flow
// (clearReconnectionSuppression + filterDebuggableDevices + purge +
// connectToDevice per device) — earlier attempts that used ensureConnection
// here raced with WS close events on first connect and reported
// "Connection succeeded but app is not available". scan_metro's pattern
// is the empirically-stable path.
//
// Returns the per-device connect failures so the caller can report *why*
// nothing attached instead of the opaque "could not connect to any device"
// (which accounted for ~a third of reload_app failures with zero diagnostics).
async function autoConnectSweep(ports: number[]): Promise<string[]> {
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

    if (portDevices.size === 0) {
        return [`Metro is running on port(s) ${ports.join(", ")} but reports no debuggable targets (is the app running and in the foreground?)`];
    }

    const failures: string[] = [];
    for (const [port, devices] of portDevices) {
        for (const dev of devices) {
            try {
                await connectToDevice(dev, port);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                console.error(`[execbro] Auto-connect failed for ${dev.title} on port ${port}: ${reason}`);
                failures.push(`${dev.deviceName || dev.title} (port ${port}): ${reason}`);
            }
        }
    }
    return failures;
}

export async function reloadApp(device?: string): Promise<ExecutionResult> {
    // Get current connection info before reload. Resolve non-throwing: a miss
    // is recoverable here (we auto-connect and re-resolve below), and the old
    // throwing resolve meant a supplied `device` skipped auto-connect entirely.
    let resolution = resolveConnectedAppByDevice(device);

    if (resolution.kind === "ambiguous") {
        // Rescanning cannot disambiguate — the agent must pick.
        return {
            success: false,
            error: describeDeviceResolution(resolution),
            errorContext: "ambiguous_device"
        };
    }

    if (resolution.kind === "none") {
        console.error("[execbro] No connection for reload, attempting auto-connect...");

        const ports = await scanMetroPorts();
        if (ports.length === 0) {
            return {
                success: false,
                error: "No apps connected and no Metro server found. Make sure Metro bundler is running (npm start or expo start), then try again.",
                errorContext: "no_metro"
            };
        }

        let failures = await autoConnectSweep(ports);
        resolution = resolveConnectedAppByDevice(device);

        // Metro's /json/list lags a freshly launched or freshly reloaded app by
        // a second or so, so a single sweep can legitimately see nothing. One
        // bounded retry converts those into successes instead of telling the
        // agent to go run scan_metro by hand.
        if (resolution.kind !== "ok") {
            await delay(AUTO_CONNECT_RETRY_DELAY_MS);
            failures = await autoConnectSweep(ports);
            resolution = resolveConnectedAppByDevice(device);
        }

        if (resolution.kind === "ambiguous") {
            return {
                success: false,
                error: describeDeviceResolution(resolution),
                errorContext: "ambiguous_device"
            };
        }

        if (resolution.kind === "none") {
            // Device argument that matched nothing gets the resolver's message
            // (it names the platform mismatch, which is the common case);
            // otherwise report why the connect attempts failed.
            const detail = failures.length > 0
                ? ` Connect attempts failed: ${failures.join("; ").substring(0, 300)}`
                : "";
            const base = device
                ? describeDeviceResolution(resolution)
                : "No apps connected. Found Metro server but could not connect to any device. Make sure the React Native app is running.";
            return {
                success: false,
                error: `${base}${detail}`,
                errorContext: device
                    ? (resolution.connected.length > 0 ? "device_mismatch_after_rescan" : "connect_failed_with_device")
                    : "connect_failed"
            };
        }
    }

    const app = resolution.app;
    const port = app.port;
    // If the in-app SDK was the network/console source before the reload, the
    // new JS context must re-run init() before get_network_requests can read
    // the SDK buffer again. Remember this so we can wait for re-readiness below
    // instead of returning into the window where the MCP falls back to the
    // duplicate-prone CDP/interceptor buffer.
    const sdkWasPresent = app.sdkPresent === true;

    // Best-effort drain: pull whatever the SDK holds before the runtime is
    // replaced. The periodic mirror poller covers process death, but a reload
    // is a boundary we can see coming, so there is no reason to lose the
    // window since the last tick.
    if (sdkWasPresent) {
        try {
            await mirrorOnce(app.deviceInfo.deviceName || app.deviceInfo.title || "unknown");
        } catch {
            // Non-fatal — the reload proceeds either way.
        }
    }

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

            // If the SDK was the source before reload, wait for the new context
            // to re-run init() and re-expose __RN_AI_DEVTOOLS__ before returning,
            // so the caller's next get_network_requests reads the SDK buffer
            // rather than falling back to the duplicate-prone CDP/interceptor
            // buffer. Bounded; non-SDK apps and slow inits just fall through.
            let sdkReady = true;
            if (sdkWasPresent) {
                const SDK_READY_TIMEOUT_MS = 5000;
                const SDK_READY_POLL_MS = 300;
                const deadline = Date.now() + SDK_READY_TIMEOUT_MS;
                sdkReady = false;
                while (Date.now() < deadline) {
                    // Poll the reloaded device specifically — an unqualified
                    // probe can answer from a different connected app.
                    if (await isSDKInstalled(device)) {
                        sdkReady = true;
                        break;
                    }
                    await delay(SDK_READY_POLL_MS);
                }
            }

            return {
                success: true,
                result: `App reloaded and reconnected to ${targetDevice.deviceName || targetDevice.title}`
                    + (sdkWasPresent && !sdkReady
                        ? " (warning: in-app SDK did not re-initialize within 5s; network/console may briefly use the fallback buffer)"
                        : "")
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
