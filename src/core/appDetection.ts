import WebSocket from "ws";
import { getNextMessageId } from "./state.js";
import { trackAppDetection } from "./telemetry.js";
import type { AppDetectionResult, ConnectedApp } from "./types.js";

const DETECTION_TIMEOUT_MS = 3000;
const DETECTION_DELAY_MS = 500;

const DETECTION_EXPRESSION = `(function(){try{var r={};var p=globalThis.nativeModuleProxy;if(p&&p.PlatformConstants){var c=p.PlatformConstants.getConstants?p.PlatformConstants.getConstants():p.PlatformConstants;if(c){if(c.reactNativeVersion)r.rnVersion=c.reactNativeVersion;if(c.osVersion)r.osVersion=c.osVersion;if(c.systemName)r.systemName=c.systemName}}r.newArch=typeof globalThis.nativeFabricUIManager==='object';r.hermes=typeof globalThis.HermesInternal!=='undefined';return r}catch(e){return null}})()`;

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
    } | null,
    platform: "ios" | "android"
): AppDetectionResult | null {
    if (!raw || !raw.rnVersion) return null;

    return {
        reactNativeVersion: formatVersion(raw.rnVersion),
        architecture: raw.newArch ? "new" : "old",
        jsEngine: raw.hermes ? "hermes" : "jsc",
        appPlatform: platform,
        osVersion: raw.osVersion || "unknown",
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
                    console.error(
                        `[rn-ai-debugger] App detected: RN ${parsed.reactNativeVersion}, ${parsed.architecture} arch, ${parsed.jsEngine}, ${parsed.appPlatform} ${parsed.osVersion}`
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
                    awaitPromise: false,
                    userGesture: true,
                    generatePreview: false,
                },
            })
        );
    });
}
