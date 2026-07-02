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
