import { homedir } from "os";
import { join } from "path";
import { isProjectMemoryEnabled } from "./config.js";
import {
    buildWriteEnvelope,
    computeProjectId,
    projectsRoot,
    readConcern,
    writeConcernAtomic,
    realpathOrRaw,
} from "./projectStore.js";

export interface ScreenMetrics {
    rawWidth: number;
    rawHeight: number;
    deliveredWidth: number;
    deliveredHeight: number;
    downscale: number;
    pointWidth?: number;
    pointHeight?: number;
    scale?: number;
    capturedAt: number;
}

export interface DeviceMemoryEntry {
    identifier: string;
    name: string;
    platform: "ios" | "android";
    appId?: string;
    firstSeenAt: number;
    lastUsedAt: number;
    useCount: number;
    screenMetrics?: ScreenMetrics;
}

export interface RecordDeviceInput {
    identifier: string;
    name: string;
    platform: "ios" | "android";
    appId?: string;
}

export interface ProjectMemoryOpts {
    cwd?: string;
    baseDir?: string;
    now?: number;
}

const DEVICES_SCHEMA = "execbro/project-devices";
const META_SCHEMA = "execbro/project-meta";
const CURRENT_VERSION = 1;
const MAX_DEVICES = 20;

/** Union by identifier: newer lastUsedAt wins wholesale; earliest firstSeenAt and
 * max useCount retained. Sorted desc by lastUsedAt, capped at MAX_DEVICES. */
export function mergeDeviceLists(a: DeviceMemoryEntry[], b: DeviceMemoryEntry[]): DeviceMemoryEntry[] {
    const byId = new Map<string, DeviceMemoryEntry>();
    for (const e of [...a, ...b]) {
        const prev = byId.get(e.identifier);
        if (!prev) {
            byId.set(e.identifier, e);
            continue;
        }
        const winner = e.lastUsedAt >= prev.lastUsedAt ? e : prev;
        byId.set(e.identifier, {
            ...winner,
            firstSeenAt: Math.min(prev.firstSeenAt, e.firstSeenAt),
            useCount: Math.max(prev.useCount, e.useCount),
        });
    }
    return [...byId.values()].sort((x, y) => y.lastUsedAt - x.lastUsedAt).slice(0, MAX_DEVICES);
}

/** Resolve project dir + device list, or null when disabled / degenerate cwd / foreign file. */
function loadDevices(opts?: ProjectMemoryOpts):
    | { dir: string; realCwd: string; existing: import("./projectStore.js").StoredEnvelope | null; devices: DeviceMemoryEntry[] }
    | null {
    if (!isProjectMemoryEnabled()) return null;
    const cwd = opts?.cwd ?? process.cwd();
    const id = computeProjectId(cwd, homedir());
    if (!id) return null;
    const dir = join(projectsRoot(opts?.baseDir), id);
    const read = readConcern(join(dir, "devices.json"), DEVICES_SCHEMA, CURRENT_VERSION);
    if (read.kind === "foreign") return null;
    const existing = read.kind === "ours" ? read.env : null;
    const devices = (existing?.devices as DeviceMemoryEntry[] | undefined) ?? [];
    return { dir, realCwd: realpathOrRaw(cwd), existing, devices };
}

function persist(dir: string, existing: import("./projectStore.js").StoredEnvelope | null, devices: DeviceMemoryEntry[], now: number): void {
    const env = buildWriteEnvelope(existing, DEVICES_SCHEMA, CURRENT_VERSION, now, { devices });
    writeConcernAtomic(join(dir, "devices.json"), env);
}

function ensureMeta(dir: string, realCwd: string, now: number): void {
    const read = readConcern(join(dir, "meta.json"), META_SCHEMA, CURRENT_VERSION);
    if (read.kind === "ours") return;   // already present (or foreign — leave it)
    if (read.kind === "foreign") return;
    const env = buildWriteEnvelope(null, META_SCHEMA, CURRENT_VERSION, now, { path: realCwd });
    writeConcernAtomic(join(dir, "meta.json"), env);
}

export function recordDevice(input: RecordDeviceInput, opts?: ProjectMemoryOpts): void {
    try {
        const ctx = loadDevices(opts);
        if (!ctx) return;
        const now = opts?.now ?? Date.now();
        const prior = ctx.devices.find((d) => d.identifier === input.identifier);
        const updated: DeviceMemoryEntry = {
            identifier: input.identifier,
            name: input.name,
            platform: input.platform,
            appId: input.appId ?? prior?.appId,
            firstSeenAt: prior?.firstSeenAt ?? now,
            lastUsedAt: now,
            useCount: (prior?.useCount ?? 0) + 1,
            screenMetrics: prior?.screenMetrics,
        };
        persist(ctx.dir, ctx.existing, mergeDeviceLists(ctx.devices, [updated]), now);
        ensureMeta(ctx.dir, ctx.realCwd, now);
    } catch {
        // best-effort — never throw into a tool flow
    }
}

export function recordScreenMetrics(identifier: string, metrics: ScreenMetrics, opts?: ProjectMemoryOpts): void {
    try {
        const ctx = loadDevices(opts);
        if (!ctx) return;
        const prior = ctx.devices.find((d) => d.identifier === identifier);
        if (!prior) return;   // enrichment only — never create an entry
        const now = opts?.now ?? Date.now();
        const updated: DeviceMemoryEntry = { ...prior, screenMetrics: metrics, lastUsedAt: now };
        persist(ctx.dir, ctx.existing, mergeDeviceLists(ctx.devices, [updated]), now);
    } catch {
        // best-effort
    }
}

export function listDevices(opts?: ProjectMemoryOpts): DeviceMemoryEntry[] {
    try {
        const ctx = loadDevices(opts);
        if (!ctx) return [];
        return [...ctx.devices].sort((x, y) => y.lastUsedAt - x.lastUsedAt);
    } catch {
        return [];
    }
}
