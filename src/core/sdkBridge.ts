import { executeInApp } from "./executor.js";
import { connectedApps } from "./state.js";

// ── Types for raw SDK entries ──

interface SDKNetworkEntry {
    id: string;
    timestamp: number;
    method: string;
    url: string;
    status?: number;
    statusText?: string;
    duration?: number;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    responseHeaders: Record<string, string>;
    responseBody?: string;
    mimeType?: string;
    error?: string;
    completed: boolean;
}

interface SDKConsoleEntry {
    id: string;
    timestamp: number;
    level: string;
    message: string;
}

type SDKResult<T> = { success: true; data: T } | { success: false; error: string };

// ── Detection ──

export async function isSDKInstalled(): Promise<boolean> {
    if (connectedApps.size === 0) return false;
    const result = await executeInApp(
        'typeof globalThis.__RN_AI_DEVTOOLS__?.getNetworkEntries === "function"',
        false,
        { timeoutMs: 3000 }
    );
    return result.success && result.result === "true";
}

// ── Raw readers ──

async function readRawNetwork(): Promise<SDKResult<SDKNetworkEntry[]>> {
    const result = await executeInApp(
        "JSON.stringify(globalThis.__RN_AI_DEVTOOLS__.getNetworkEntries())",
        false,
        { timeoutMs: 5000 }
    );
    if (!result.success) return { success: false, error: result.error || "executeInApp failed" };
    try {
        return { success: true, data: JSON.parse(result.result!) };
    } catch {
        return { success: false, error: "Failed to parse SDK response" };
    }
}

async function readRawConsole(): Promise<SDKResult<SDKConsoleEntry[]>> {
    const result = await executeInApp(
        "JSON.stringify(globalThis.__RN_AI_DEVTOOLS__.getConsoleEntries())",
        false,
        { timeoutMs: 5000 }
    );
    if (!result.success) return { success: false, error: result.error || "executeInApp failed" };
    try {
        return { success: true, data: JSON.parse(result.result!) };
    } catch {
        return { success: false, error: "Failed to parse SDK response" };
    }
}

// ── Server-side network queries ──

export async function querySDKNetwork(options: {
    count?: number;
    method?: string;
    urlPattern?: string;
    status?: number;
} = {}): Promise<SDKResult<SDKNetworkEntry[]>> {
    const raw = await readRawNetwork();
    if (!raw.success) return raw;

    let entries = raw.data;

    if (options.method) {
        const m = options.method.toUpperCase();
        entries = entries.filter(e => e.method === m);
    }
    if (options.urlPattern) {
        const p = options.urlPattern.toLowerCase();
        entries = entries.filter(e => e.url.toLowerCase().includes(p));
    }
    if (options.status != null) {
        entries = entries.filter(e => e.status === options.status);
    }

    // newest first
    entries = entries.reverse();

    if (options.count != null && options.count > 0) {
        entries = entries.slice(0, options.count);
    }

    return { success: true, data: entries };
}

export async function getSDKNetworkEntry(id: string): Promise<SDKResult<SDKNetworkEntry | null>> {
    const raw = await readRawNetwork();
    if (!raw.success) return raw as SDKResult<SDKNetworkEntry | null>;

    const entry = raw.data.find(e => e.id === id) ?? null;
    return { success: true, data: entry };
}

export async function getSDKNetworkStats(): Promise<SDKResult<{
    total: number;
    completed: number;
    errors: number;
    avgDuration: number | null;
    byMethod: Record<string, number>;
    byStatus: Record<string, number>;
    byDomain: Record<string, number>;
}>> {
    const raw = await readRawNetwork();
    if (!raw.success) return raw as any;

    const all = raw.data;
    const completed = all.filter(e => e.completed && !e.error);
    const errors = all.filter(e => !!e.error);

    const durations = completed
        .map(e => e.duration)
        .filter((d): d is number => d != null);

    const avgDuration = durations.length > 0
        ? durations.reduce((sum, d) => sum + d, 0) / durations.length
        : null;

    const byMethod: Record<string, number> = {};
    for (const e of all) {
        byMethod[e.method] = (byMethod[e.method] || 0) + 1;
    }

    const byStatus: Record<string, number> = {};
    for (const e of all) {
        if (e.status != null) {
            const group = `${Math.floor(e.status / 100)}xx`;
            byStatus[group] = (byStatus[group] || 0) + 1;
        }
    }

    const byDomain: Record<string, number> = {};
    for (const e of all) {
        try {
            const domain = new URL(e.url).hostname;
            byDomain[domain] = (byDomain[domain] || 0) + 1;
        } catch {
            // skip malformed URLs
        }
    }

    return {
        success: true,
        data: { total: all.length, completed: completed.length, errors: errors.length, avgDuration, byMethod, byStatus, byDomain }
    };
}

// ── Server-side console queries ──

export async function querySDKConsole(options: {
    count?: number;
    level?: string;
    text?: string;
} = {}): Promise<SDKResult<SDKConsoleEntry[]>> {
    const raw = await readRawConsole();
    if (!raw.success) return raw;

    let entries = raw.data;

    if (options.level) {
        entries = entries.filter(e => e.level === options.level);
    }
    if (options.text) {
        const t = options.text.toLowerCase();
        entries = entries.filter(e => e.message.toLowerCase().includes(t));
    }

    // newest first
    entries = entries.reverse();

    if (options.count != null && options.count > 0) {
        entries = entries.slice(0, options.count);
    }

    return { success: true, data: entries };
}

export async function getSDKConsoleStats(): Promise<SDKResult<{
    total: number;
    byLevel: Record<string, number>;
}>> {
    const raw = await readRawConsole();
    if (!raw.success) return raw as any;

    const byLevel: Record<string, number> = {};
    for (const e of raw.data) {
        byLevel[e.level] = (byLevel[e.level] || 0) + 1;
    }

    return { success: true, data: { total: raw.data.length, byLevel } };
}

// ── Mutations ──

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

export async function clearSDKConsole(): Promise<{ success: boolean; count?: number; error?: string }> {
    const result = await executeInApp(
        "globalThis.__RN_AI_DEVTOOLS__.clearConsole()",
        false,
        { timeoutMs: 3000 }
    );
    if (!result.success) return { success: false, error: result.error };
    const count = parseInt(result.result || "0", 10);
    return { success: true, count: isNaN(count) ? 0 : count };
}
