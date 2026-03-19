import { executeInApp } from "./executor.js";
import { connectedApps } from "./state.js";

/**
 * Check if the SDK is installed in the connected app.
 */
export async function isSDKInstalled(): Promise<boolean> {
    if (connectedApps.size === 0) return false;
    const result = await executeInApp(
        'typeof globalThis.__RN_AI_DEVTOOLS__?.getNetworkRequests === "function"',
        false,
        { timeoutMs: 3000 }
    );
    return result.success && result.result === "true";
}

/**
 * Read network requests from the SDK's in-app buffer.
 */
export async function readSDKNetworkRequests(options: {
    count?: number;
    method?: string;
    urlPattern?: string;
    status?: number;
} = {}): Promise<{ success: boolean; data?: any; error?: string }> {
    const optionsJson = JSON.stringify(options);
    const result = await executeInApp(
        `JSON.stringify(globalThis.__RN_AI_DEVTOOLS__.getNetworkRequests(${optionsJson}))`,
        false,
        { timeoutMs: 5000 }
    );
    if (!result.success) return { success: false, error: result.error };
    try {
        const data = JSON.parse(result.result!);
        return { success: true, data };
    } catch {
        return { success: false, error: "Failed to parse SDK response" };
    }
}

/**
 * Read a single network request by ID from the SDK (includes full body).
 */
export async function readSDKNetworkRequest(id: string): Promise<{ success: boolean; data?: any; error?: string }> {
    const result = await executeInApp(
        `JSON.stringify(globalThis.__RN_AI_DEVTOOLS__.getNetworkRequest(${JSON.stringify(id)}))`,
        false,
        { timeoutMs: 5000 }
    );
    if (!result.success) return { success: false, error: result.error };
    try {
        const data = JSON.parse(result.result!);
        return { success: true, data };
    } catch {
        return { success: false, error: "Failed to parse SDK response" };
    }
}

/**
 * Read network stats from the SDK.
 */
export async function readSDKNetworkStats(): Promise<{ success: boolean; data?: any; error?: string }> {
    const result = await executeInApp(
        "JSON.stringify(globalThis.__RN_AI_DEVTOOLS__.getNetworkStats())",
        false,
        { timeoutMs: 5000 }
    );
    if (!result.success) return { success: false, error: result.error };
    try {
        const data = JSON.parse(result.result!);
        return { success: true, data };
    } catch {
        return { success: false, error: "Failed to parse SDK response" };
    }
}

/**
 * Clear the SDK's network buffer.
 */
export async function clearSDKNetwork(): Promise<{ success: boolean; count?: number; error?: string }> {
    const result = await executeInApp(
        "globalThis.__RN_AI_DEVTOOLS__.clearNetwork()",
        false,
        { timeoutMs: 3000 }
    );
    if (!result.success) return { success: false, error: result.error };
    const count = parseInt(result.result || "0", 10);
    return { success: true, count: isNaN(count) ? 0 : count };
}
