import WebSocket from "ws";
import { getNextMessageId } from "./state.js";
import { trackAppDetection } from "./telemetry.js";
import type { AppDetectionResult, ConnectedApp } from "./types.js";

const DETECTION_TIMEOUT_MS = 3000;
const DETECTION_DELAY_MS = 500;

// Detection expression — returns a Promise (used with awaitPromise: true).
// The .then() defers to a microtask so the RN module system is fully initialized.
// Fallback paths for PlatformConstants:
// 1. nativeModuleProxy.PlatformConstants (Bridgeless / New Arch)
// 2. __turboModuleProxy('PlatformConstants') (TurboModules)
// 3. __fbBatchedBridgeConfig.remoteModuleConfig (Old Arch Bridge — inlined constants)
// 4. nativeRequireModuleConfig (Old Arch Bridge — lazy load)
// Always returns arch/engine even when version is unavailable.
const DETECTION_EXPRESSION = `Promise.resolve().then(function(){
var r={},c=null,p=globalThis.nativeModuleProxy;
if(p&&p.PlatformConstants){c=typeof p.PlatformConstants.getConstants==='function'?p.PlatformConstants.getConstants():p.PlatformConstants}
if(!c&&typeof globalThis.__turboModuleProxy==='function'){try{var tm=globalThis.__turboModuleProxy('PlatformConstants');if(tm)c=typeof tm.getConstants==='function'?tm.getConstants():tm}catch(e){}}
if(!c){var bc=globalThis.__fbBatchedBridgeConfig;if(bc&&bc.remoteModuleConfig){for(var i=0;i<bc.remoteModuleConfig.length;i++){var mc=bc.remoteModuleConfig[i];if(mc&&mc[0]==='PlatformConstants'&&mc[1]){c=mc[1];break}}}}
if(!c&&typeof globalThis.nativeRequireModuleConfig==='function'){try{var nc=globalThis.nativeRequireModuleConfig('PlatformConstants');if(typeof nc==='string')nc=JSON.parse(nc);if(nc&&nc[1])c=nc[1]}catch(e){}}
if(c){if(c.reactNativeVersion)r.rnVersion=c.reactNativeVersion;if(c.osVersion)r.osVersion=c.osVersion;if(c.systemName)r.systemName=c.systemName}
r.newArch=typeof globalThis.nativeFabricUIManager==='object';
r.hermes=typeof globalThis.HermesInternal!=='undefined';
var ep=p&&p.ExpoConstants;if(!ep&&typeof globalThis.__turboModuleProxy==='function'){try{ep=globalThis.__turboModuleProxy('ExpoConstants')}catch(e){}}
if(ep){try{var ec=typeof ep.getConstants==='function'?ep.getConstants():ep;if(ec&&ec.expoConfig&&ec.expoConfig.sdkVersion)r.expoSdk=ec.expoConfig.sdkVersion}catch(e){}}
return r})`;

function formatVersion(v: { major: number; minor: number; patch: number }): string {
    return `${v.major}.${v.minor}.${v.patch}`;
}

function parseDetectionResult(
    raw: {
        rnVersion?: { major: number; minor: number; patch: number };
        osVersion?: string;
        systemName?: string;
        newArch?: boolean;
        hermes?: boolean;
        expoSdk?: string;
    } | null,
    platform: "ios" | "android"
): AppDetectionResult | null {
    if (!raw) return null;
    // Accept partial results — arch/engine are always detectable even when
    // PlatformConstants is unavailable (e.g., Old Arch without nativeModuleProxy)
    if (raw.newArch === undefined && raw.hermes === undefined && !raw.rnVersion) return null;

    return {
        reactNativeVersion: raw.rnVersion ? formatVersion(raw.rnVersion) : "unknown",
        architecture: raw.newArch ? "new" : "old",
        jsEngine: raw.hermes ? "hermes" : "jsc",
        appPlatform: platform,
        osVersion: raw.osVersion || "unknown",
        ...(raw.expoSdk ? { expoSdkVersion: raw.expoSdk } : {}),
    };
}

/**
 * Detect app characteristics via Runtime.evaluate CDP command.
 * Fire-and-forget — does not block connection flow.
 * Stores result on the ConnectedApp object.
 */
export function scheduleAppDetection(app: ConnectedApp): void {
    // Skip if already detected (e.g., on reconnection)
    if (app.appDetection) return;

    setTimeout(async () => {
        try {
            const result = await detectApp(app.ws);
            if (result) {
                const parsed = parseDetectionResult(result, app.platform);
                if (parsed) {
                    app.appDetection = parsed;
                    trackAppDetection(parsed);
                    const versionStr = parsed.reactNativeVersion !== "unknown"
                        ? `RN ${parsed.reactNativeVersion}, ` : "";
                    console.error(
                        `[rn-ai-debugger] App detected: ${versionStr}${parsed.architecture} arch, ${parsed.jsEngine}, ${parsed.appPlatform} ${parsed.osVersion}`
                    );
                }
            }
        } catch (e) {
            console.error(`[rn-ai-debugger] App detection failed: ${e}`);
        }
    }, DETECTION_DELAY_MS);
}

function detectApp(ws: WebSocket): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
        if (ws.readyState !== WebSocket.OPEN) {
            resolve(null);
            return;
        }

        const messageId = getNextMessageId();
        const timeout = setTimeout(() => {
            ws.removeListener("message", handler);
            resolve(null);
        }, DETECTION_TIMEOUT_MS);

        function handler(data: WebSocket.Data) {
            try {
                const message = JSON.parse(data.toString());
                if (message.id !== messageId) return;

                ws.removeListener("message", handler);
                clearTimeout(timeout);

                if (message.result?.result?.value) {
                    resolve(message.result.result.value);
                } else {
                    resolve(null);
                }
            } catch {
                // Ignore non-JSON messages
            }
        }

        ws.on("message", handler);

        ws.send(
            JSON.stringify({
                id: messageId,
                method: "Runtime.evaluate",
                params: {
                    expression: DETECTION_EXPRESSION,
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: true,
                    generatePreview: false,
                },
            })
        );
    });
}
