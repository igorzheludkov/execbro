import { executeInApp } from "./executor.js";

export type FlowpointLevel = "info" | "warn" | "error";

export interface FlowpointEntry {
    seq: number;
    t: number;
    name: string;
    step: string;
    run: string;
    level: FlowpointLevel;
    meta?: unknown;
}

export interface FlowpointSnapshot {
    contextId: string;
    entries: FlowpointEntry[];
}

export const FLOWPOINT_STORE_CAP = 2000;

export interface FlowpointStoreState {
    entries: FlowpointEntry[];
    cursor: number; // highest seq seen for the current contextId
    contextId: string | null;
}

export function createFlowpointStore(): FlowpointStoreState {
    return { entries: [], cursor: 0, contextId: null };
}

/** Pure drain reducer: diff a full in-app snapshot against the store. Returns entries appended. */
export function applyDrain(store: FlowpointStoreState, snapshot: FlowpointSnapshot): number {
    const reset = store.contextId !== snapshot.contextId;
    const fresh = reset ? snapshot.entries : snapshot.entries.filter((e) => e.seq > store.cursor);
    store.entries.push(...fresh);
    if (store.entries.length > FLOWPOINT_STORE_CAP) {
        store.entries.splice(0, store.entries.length - FLOWPOINT_STORE_CAP);
    }
    const maxSeq = snapshot.entries.reduce((m, e) => Math.max(m, e.seq), 0);
    store.cursor = reset ? maxSeq : Math.max(store.cursor, maxSeq);
    store.contextId = snapshot.contextId;
    return fresh.length;
}

export function buildDrainExpression(): string {
    return `(() => {
        const g = globalThis.__EXECBRO__ ?? globalThis.__RN_AI_DEVTOOLS__;
        if (!g || typeof g.getFlowpointSnapshot !== "function") return JSON.stringify({ __missing: true });
        const s = g.getFlowpointSnapshot();
        const entries = s.entries.map((e) => {
            try { JSON.stringify(e.meta); return e; }
            catch { return Object.assign({}, e, { meta: { __error: "meta not JSON-serializable" } }); }
        });
        return JSON.stringify({ contextId: s.contextId, entries });
    })()`;
}

export function buildClearExpression(): string {
    return `(() => {
        const g = globalThis.__EXECBRO__ ?? globalThis.__RN_AI_DEVTOOLS__;
        return g && typeof g.clearFlowpoints === "function" ? String(g.clearFlowpoints()) : "0";
    })()`;
}

export function parseDrainResult(raw: string): FlowpointSnapshot | { missing: true } | null {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.__missing === true) return { missing: true };
        if (parsed && typeof parsed.contextId === "string" && Array.isArray(parsed.entries)) {
            return parsed as FlowpointSnapshot;
        }
        return null;
    } catch {
        return null;
    }
}

export interface FlowpointFilters {
    name?: string;
    step?: string;
    run?: string; // "last" or an explicit run id
    level?: FlowpointLevel;
    metaIncludes?: string;
    since?: number;
    limit?: number;
}

export function formatMeta(meta: unknown): string {
    if (meta === undefined) return "";
    if (typeof meta === "string") return meta;
    try {
        return JSON.stringify(meta);
    } catch {
        return String(meta);
    }
}

export interface PointMatch {
    step?: string;
    level?: FlowpointLevel;
    metaIncludes?: string;
}

export function matchesPoint(entry: FlowpointEntry, match: PointMatch): boolean {
    if (match.step !== undefined && entry.step !== match.step) return false;
    if (match.level !== undefined && entry.level !== match.level) return false;
    if (
        match.metaIncludes !== undefined &&
        !formatMeta(entry.meta).toLowerCase().includes(match.metaIncludes.toLowerCase())
    ) {
        return false;
    }
    return true;
}

/** Per flow name, the run id of the chronologically last entry. Assumes entries sorted by t. */
export function resolveLastRuns(entries: FlowpointEntry[]): Map<string, string> {
    const last = new Map<string, string>();
    for (const entry of entries) {
        last.set(entry.name, entry.run);
    }
    return last;
}

export function filterFlowpoints(entries: FlowpointEntry[], filters: FlowpointFilters): FlowpointEntry[] {
    let result = entries;
    if (filters.name !== undefined) result = result.filter((e) => e.name === filters.name);
    if (filters.run === "last") {
        const lastRuns = resolveLastRuns(result);
        result = result.filter((e) => lastRuns.get(e.name) === e.run);
    } else if (filters.run !== undefined) {
        result = result.filter((e) => e.run === filters.run);
    }
    if (filters.step !== undefined) result = result.filter((e) => e.step === filters.step);
    if (filters.level !== undefined) result = result.filter((e) => e.level === filters.level);
    if (filters.metaIncludes !== undefined) {
        const needle = filters.metaIncludes.toLowerCase();
        result = result.filter((e) => formatMeta(e.meta).toLowerCase().includes(needle));
    }
    if (filters.since !== undefined) result = result.filter((e) => e.t > filters.since!);
    const limit = filters.limit ?? 200;
    if (result.length > limit) result = result.slice(result.length - limit);
    return result;
}

function formatPointLine(entry: FlowpointEntry, t0: number, indent: string): string {
    const delta = `+${entry.t - t0}ms`.padEnd(9);
    const levelPrefix = entry.level !== "info" ? `[${entry.level}] ` : "";
    const meta = entry.meta !== undefined ? `  ${formatMeta(entry.meta)}` : "";
    return `${indent}${delta}${levelPrefix}${entry.step}${meta}`;
}

function formatRunBlock(runId: string, runEntries: FlowpointEntry[], latest: boolean, indent: string): string {
    const span = runEntries[runEntries.length - 1].t - runEntries[0].t;
    const label = latest ? ` (latest)` : "";
    const header = `${indent}run ${runId}${label} — ${runEntries.length} points (${span}ms span):`;
    const lines = runEntries.map((e) => formatPointLine(e, runEntries[0].t, indent + "  "));
    return [header, ...lines].join("\n");
}

/** Compact grouped text: flow → run → points with inter-point deltas. Assumes entries sorted by t. */
export function formatFlowpoints(entries: FlowpointEntry[]): string {
    const lastRuns = resolveLastRuns(entries);
    const byName = new Map<string, Map<string, FlowpointEntry[]>>();
    for (const entry of entries) {
        let runs = byName.get(entry.name);
        if (!runs) {
            runs = new Map();
            byName.set(entry.name, runs);
        }
        let run = runs.get(entry.run);
        if (!run) {
            run = [];
            runs.set(entry.run, run);
        }
        run.push(entry);
    }
    const blocks: string[] = [];
    for (const [name, runs] of byName) {
        const runIds = [...runs.keys()];
        if (runIds.length === 1) {
            const runEntries = runs.get(runIds[0])!;
            const span = runEntries[runEntries.length - 1].t - runEntries[0].t;
            const header = `Flow "${name}" run ${runIds[0]} — ${runEntries.length} points (${span}ms span):`;
            blocks.push([header, ...runEntries.map((e) => formatPointLine(e, runEntries[0].t, "  "))].join("\n"));
        } else {
            const header = `Flow "${name}" — ${runIds.length} runs`;
            const runBlocks = runIds.map((id) => formatRunBlock(id, runs.get(id)!, id === lastRuns.get(name), "  "));
            blocks.push([header, ...runBlocks].join("\n"));
        }
    }
    return blocks.join("\n\n");
}

const flowpointStores = new Map<string, FlowpointStoreState>();

export function getFlowpointStore(deviceName: string): FlowpointStoreState {
    let store = flowpointStores.get(deviceName);
    if (!store) {
        store = createFlowpointStore();
        flowpointStores.set(deviceName, store);
    }
    return store;
}

/** All stored entries across devices, sorted chronologically. */
export function allStoredFlowpoints(): FlowpointEntry[] {
    const all: FlowpointEntry[] = [];
    for (const store of flowpointStores.values()) {
        all.push(...store.entries);
    }
    return all.sort((a, b) => a.t - b.t);
}

/** Remove entries from the server stores. Cursors/contextIds are kept so cleared entries never re-drain. */
export function clearFlowpointStores(name?: string): number {
    let removed = 0;
    for (const store of flowpointStores.values()) {
        if (name === undefined) {
            removed += store.entries.length;
            store.entries = [];
        } else {
            const before = store.entries.length;
            store.entries = store.entries.filter((e) => e.name !== name);
            removed += before - store.entries.length;
        }
    }
    return removed;
}

export const SDK_FLOWPOINTS_MISSING =
    "Flowpoints require the execbro-sdk: npm install execbro-sdk, call init() at app start, " +
    "then instrument the flow with flowpoint({ name, step }). Older SDK versions without " +
    'flowpoint support must be upgraded. See get_usage_guide(topic="flowpoints").';

export type DrainOutcome = { ok: true } | { ok: false; error: string; sdkMissing?: boolean };

export async function drainFlowpoints(deviceName: string, device?: string): Promise<DrainOutcome> {
    const result = await executeInApp(
        buildDrainExpression(),
        false,
        { timeoutMs: 5000, originatingToolName: "flowpoints" },
        device,
    );
    if (!result.success) {
        return { ok: false, error: result.error || "executeInApp failed" };
    }
    const parsed = parseDrainResult(result.result ?? "");
    if (parsed === null) {
        return { ok: false, error: "Failed to parse flowpoint snapshot from the app" };
    }
    if ("missing" in parsed) {
        return { ok: false, error: SDK_FLOWPOINTS_MISSING, sdkMissing: true };
    }
    applyDrain(getFlowpointStore(deviceName), parsed);
    return { ok: true };
}
