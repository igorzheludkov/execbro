/**
 * Gathers get_timeline's events. Buffers are read directly (they hold data
 * across disconnects); in-app reads go through SourceDeps so tests never need
 * a device. A source that fails is named, never fatal.
 */

import { logBuffers, networkBuffers, connectedApps, epochStarts } from "./state.js";
import { getActions, deviceMatches } from "./actionLog.js";
import { readRouteHistory, sampledVisits } from "./routeHistory.js";
import { getRefreshStatus } from "./fastRefreshTools.js";
import { executeInApp } from "./jsExecute.js";
import { chromiumNavigations } from "./chromiumNavigation.js";
import type { ConnectedApp } from "./types.js";
import {
    actionEvent, logEvent, requestEvent, routeEvent, restartEvent, refreshEvent, hostOf,
    type TimelineEvent, type TimelineSource, type TimelineWindow,
} from "./timeline.js";

export const CLOCK_NOTE_THRESHOLD_MS = 250;

export interface SourceDeps {
    readRoutes(device: string): Promise<Array<{ route: string; from: string | null; enteredAt: number }>>;
    readRefresh(device: string): Promise<Array<{ at: number; modulePath?: string }>>;
    probeDeviceNow(device: string): Promise<number>;
}

const realDeps: SourceDeps = {
    readRoutes: async (device) => (await readRouteHistory(device)).visits,
    readRefresh: async (device) => {
        const r = await getRefreshStatus({ device });
        if (!r.success) throw new Error(r.error ?? "refresh read failed");
        return r.recentUpdates ?? [];
    },
    probeDeviceNow: async (device) => {
        const r = await executeInApp("Date.now()", false, { originatingToolName: "get_timeline", maxRetries: 0, timeoutMs: 3000 }, device);
        const n = Number(r.result);
        if (!r.success || !Number.isFinite(n)) throw new Error(r.error ?? "clock probe failed");
        return n;
    },
};

export interface CollectOptions {
    device?: string;
    sources: TimelineSource[];
    window: TimelineWindow;
}

export interface CollectResult {
    events: TimelineEvent[];
    devices: string[];
    notes: string[];
    unavailable: TimelineSource[];
}

function knownDevices(): string[] {
    const names = new Set<string>([...logBuffers.keys(), ...networkBuffers.keys()]);
    for (const app of connectedApps.values()) names.add(app.deviceInfo.deviceName);
    return [...names];
}

export function timelineDevices(device?: string): string[] {
    const names = knownDevices();
    if (!device) return names;
    const needle = device.toLowerCase();
    const hit = names.find((n) => n.toLowerCase().includes(needle));
    return [hit ?? device];
}

function appFor(deviceName: string): ConnectedApp | undefined {
    for (const app of connectedApps.values()) if (app.deviceInfo.deviceName === deviceName) return app;
    return undefined;
}

/** The simulator shares the host clock; everything else may drift. */
function needsClockProbe(app: ConnectedApp): boolean {
    return !(app.platform === "ios" && app.simulatorUdid);
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export async function collectTimeline(opts: CollectOptions, deps: SourceDeps = realDeps): Promise<CollectResult> {
    const { window, sources } = opts;
    const want = (s: TimelineSource) => sources.includes(s);
    const inWindow = (at: number) => at >= window.start && at <= window.end;
    const devices = timelineDevices(opts.device);
    const events: TimelineEvent[] = [];
    const notes: string[] = [];
    const unavailable = new Set<TimelineSource>();
    const fail = (s: TimelineSource, why: string) => {
        unavailable.add(s);
        notes.push(`${s}: unavailable (${why})`);
    };
    // Nothing has ever connected: in-app sources have no device to read from.
    if (devices.length === 0) {
        for (const s of ["routes", "refresh"] as const) if (want(s)) fail(s, "no app has connected yet");
    }

    if (want("actions")) {
        for (const a of getActions()) {
            if (!inWindow(a.startedAt)) continue;
            if (opts.device && !deviceMatches(a.device, devices[0])) continue;
            const tag = a.device
                ? devices.find((d) => deviceMatches(a.device, d)) ?? a.device
                : devices.length === 1 ? devices[0] : "default";
            events.push(actionEvent(a, tag));
        }
    }

    for (const device of devices) {
        for (const s of epochStarts(device)) {
            if (inWindow(s.at)) events.push(restartEvent(s.epoch, s.at, device));
        }

        if (want("logs")) {
            const buffer = logBuffers.get(device);
            const all = buffer?.getAll() ?? [];
            for (const e of all) if (inWindow(e.timestamp.getTime())) events.push(logEvent(e, device));
            if (buffer && buffer.droppedCount > 0 && all.length > 0 && all[0].timestamp.getTime() > window.start) {
                notes.push(`logs (${device}): older entries were evicted, so the start of this window may be incomplete. Raise EXECBRO_LOG_BUFFER_SIZE to keep more.`);
            }
        }

        if (want("network")) {
            const buffer = networkBuffers.get(device);
            const all = buffer?.getAll({}) ?? [];
            const inside = all.filter((r) => inWindow(r.timestamp.getTime()));
            const hosts = new Set(inside.map((r) => hostOf(r.url)).filter(Boolean));
            for (const r of inside) events.push(requestEvent(r, device, hosts.size > 1));
            if (buffer && buffer.droppedCount > 0 && all.length > 0 && all[0].timestamp.getTime() > window.start) {
                notes.push(`network (${device}): older requests were evicted, so the start of this window may be incomplete. Raise EXECBRO_NET_BUFFER_SIZE to keep more.`);
            }
        }

        if (!want("routes") && !want("refresh")) continue;
        const app = appFor(device);

        if (app?.platform === "chromium") {
            if (want("routes")) {
                let prev: { route: string; epoch: number } | null = null;
                for (const n of chromiumNavigations(device)) {
                    if (inWindow(n.at)) {
                        events.push(routeEvent({ route: n.route, from: prev && prev.epoch === n.epoch ? prev.route : null, at: n.at }, device));
                    }
                    prev = n;
                }
            }
            continue;
        }

        if (!app || app.runtime === "native") {
            if (want("routes")) {
                for (const v of sampledVisits(device)) {
                    if (inWindow(v.enteredAt)) events.push(routeEvent({ route: v.route, from: v.from, at: v.enteredAt }, device));
                }
                notes.push(`routes (${device}): app not connected, showing the trail recorded earlier.`);
            }
            if (want("refresh")) fail("refresh", `${device} not connected`);
            continue;
        }

        let offset = 0;
        if (needsClockProbe(app)) {
            try {
                const t0 = Date.now();
                const deviceNow = await deps.probeDeviceNow(device);
                const t1 = Date.now();
                offset = deviceNow - (t0 + t1) / 2;
                if (Math.abs(offset) > CLOCK_NOTE_THRESHOLD_MS) {
                    notes.push(`routes and refresh (${device}): device clock differs by ${Math.round(offset)}ms; positions are corrected by that estimate.`);
                }
            } catch (e) {
                notes.push(`routes and refresh (${device}): clock probe failed (${message(e)}); positions use the device clock as is.`);
            }
        }

        if (want("routes")) {
            try {
                for (const v of await deps.readRoutes(device)) {
                    const at = v.enteredAt - offset;
                    if (inWindow(at)) events.push(routeEvent({ route: v.route, from: v.from, at }, device));
                }
            } catch (e) {
                fail("routes", message(e));
            }
        }

        if (want("refresh")) {
            try {
                for (const u of await deps.readRefresh(device)) {
                    const at = u.at - offset;
                    if (inWindow(at)) events.push(refreshEvent(u, at, device));
                }
            } catch (e) {
                fail("refresh", message(e));
            }
        }
    }

    return { events, devices, notes, unavailable: [...unavailable] };
}
