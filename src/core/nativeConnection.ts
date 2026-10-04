/**
 * Transport to native Android apps running execbro-sdk-android.
 *
 * The SDK serves a WebSocket on the abstract socket execbro_<package>; adb
 * forward maps it to a local port. Messages use a CDP-shaped envelope
 * ({id, method, params} / {id, result|error} / {method, params}) but none of
 * CDP's domains, so this file owns its own pending map instead of going
 * through handleCDPMessage.
 *
 * Design: docs/devtools-core/specs/2026-10-03-android-native-sdk-design.md
 */

import WebSocket from "ws";
import { execFileAsync } from "./exec.js";
import { connectedApps } from "./state.js";
import type { ConnectedApp } from "./types.js";

export const NATIVE_PROTOCOL_VERSION = 1;
// The SDK gives app code 5 s on the main thread; allow for the transport on top.
const DEFAULT_TIMEOUT_MS = 8000;
const OPEN_TIMEOUT_MS = 5000;

export class NativeRpcError extends Error {
    constructor(public code: string, message: string, public data?: unknown) {
        super(message);
        this.name = "NativeRpcError";
    }
}

interface NativeHello {
    protocolVersion: number;
    sdkVersion: string;
    package: string;
    label: string;
    versionName: string | null;
    capabilities: string[];
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const pendingBySocket = new WeakMap<WebSocket, Map<number, Pending>>();
let nextId = 1;

export function nativeAppKey(serial: string, pkg: string): string {
    return `native:${serial}:${pkg}`;
}

function attachRpc(ws: WebSocket): void {
    const pending = new Map<number, Pending>();
    pendingBySocket.set(ws, pending);
    ws.on("message", (data) => {
        let msg: { id?: unknown; result?: unknown; error?: { code: string; message: string; data?: unknown } };
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (typeof msg.id !== "number") return; // events (nav.changed) have no consumer in v1
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new NativeRpcError(msg.error.code, msg.error.message, msg.error.data));
        else p.resolve(msg.result);
    });
    ws.on("close", () => {
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(new NativeRpcError("DISCONNECTED", "The app closed the connection (it was stopped, crashed or reinstalled). Relaunch it and call ensure_connection."));
        }
        pending.clear();
    });
}

export function nativeRequest<T = unknown>(
    ws: WebSocket,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
    const pending = pendingBySocket.get(ws);
    if (!pending || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new NativeRpcError("DISCONNECTED", "Not connected to the app. Call ensure_connection."));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new NativeRpcError("TIMEOUT", `${method} got no reply within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        ws.send(JSON.stringify(params ? { id, method, params } : { id, method }));
    });
}

/** Opens the WebSocket, checks the protocol version and registers the app. */
export async function openNativeSocket(
    url: string,
    target: { serial: string; pkg: string; port: number },
    onClosed: () => void = () => {}
): Promise<ConnectedApp> {
    const key = nativeAppKey(target.serial, target.pkg);
    const ws = new WebSocket(url);
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Opening ${url} timed out`)), OPEN_TIMEOUT_MS);
            ws.once("open", () => { clearTimeout(timer); resolve(); });
            ws.once("error", (e) => { clearTimeout(timer); reject(e); });
        });
        attachRpc(ws);
        const hello = await nativeRequest<NativeHello>(ws, "execbro.hello");
        if (hello.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
            const update = hello.protocolVersion > NATIVE_PROTOCOL_VERSION ? "execbro" : "execbro-sdk-android in the app";
            throw new Error(`The app's execbro-sdk-android speaks protocol ${hello.protocolVersion}; this execbro speaks ${NATIVE_PROTOCOL_VERSION}. Update ${update}.`);
        }
        const app: ConnectedApp = {
            ws,
            deviceInfo: {
                id: key,
                title: hello.label,
                description: target.pkg,
                appId: target.pkg,
                type: "native",
                webSocketDebuggerUrl: url,
                deviceName: hello.label
            },
            port: target.port,
            platform: "android",
            adbSerial: target.serial,
            runtime: "native",
            nativePackage: target.pkg,
            nativeCapabilities: hello.capabilities
        };
        connectedApps.set(key, app);
        // The open-time error listener is gone after its first error; an error with no
        // listener throws and would take the whole server down. The close handler cleans up.
        ws.on("error", () => {});
        ws.on("close", () => {
            if (connectedApps.get(key)?.ws === ws) connectedApps.delete(key);
            onClosed();
        });
        return app;
    } catch (e) {
        ws.terminate();
        throw e;
    }
}

async function removeForward(serial: string, port: number): Promise<void> {
    await execFileAsync("adb", ["-s", serial, "forward", "--remove", `tcp:${port}`], { timeout: 5000 }).catch(() => {});
}

const connecting = new Map<string, Promise<ConnectedApp>>();

/**
 * Forwards execbro_<pkg> on the device to a free local port and connects to it.
 * Concurrent calls for one app (scan_metro and ensure_connection in parallel)
 * share a single attempt instead of opening a second forward and socket.
 */
export function connectNativeApp(serial: string, pkg: string): Promise<ConnectedApp> {
    const key = nativeAppKey(serial, pkg);
    const existing = connectedApps.get(key);
    if (existing && existing.ws.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    let attempt = connecting.get(key);
    if (!attempt) {
        attempt = forwardAndOpen(serial, pkg).finally(() => connecting.delete(key));
        connecting.set(key, attempt);
    }
    return attempt;
}

async function forwardAndOpen(serial: string, pkg: string): Promise<ConnectedApp> {
    const { stdout } = await execFileAsync("adb", ["-s", serial, "forward", "tcp:0", `localabstract:execbro_${pkg}`], { timeout: 5000 });
    const port = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`adb forward returned no port: "${stdout.trim()}"`);
    try {
        return await openNativeSocket(`ws://127.0.0.1:${port}`, { serial, pkg, port }, () => void removeForward(serial, port));
    } catch (e) {
        await removeForward(serial, port);
        throw e;
    }
}
