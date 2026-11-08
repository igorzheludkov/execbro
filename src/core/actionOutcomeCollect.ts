/**
 * Collects an action's outcome around the gesture: a text snapshot before, then a
 * capped wait for network idle, a snapshot after, and the window's requests, logs and
 * restarts through get_timeline's own collector. Every source degrades on its own to an
 * `unavailable` entry: the gesture was delivered, so a failed read never fails the tap.
 */

import { buildOutcome, snapshotFromScreenState, type ActionOutcome, type OutcomeSnapshot } from "./actionOutcome.js";
import { waitForNetworkIdle, IDLE_CAP_MS, IDLE_GRACE_MS, type IdleDeps } from "./networkIdle.js";
import { collectTimeline, type CollectResult } from "./timelineSources.js";
import { refreshMirror } from "./sdkMirrorPoller.js";
import { resolveDeviceTarget } from "./deviceResolver.js";
import { chromiumAppFor, getConnectedAppByDevice, resolveConnectedAppByDevice } from "./connection.js";
import { chromiumScreenState } from "./chromiumScreen.js";
import { readTextSnapshot } from "./textSnapshot.js";
import { networkBuffers } from "./state.js";
import { delay } from "./jsExecute.js";

/** In-app rows carry the device clock; this much slack keeps them inside the window. */
const CLOCK_PAD_MS = 250;

export interface OutcomeDeps {
    resolveApp(device?: string): Promise<{ deviceName: string; chromium: boolean } | null>;
    readSnapshot(deviceName: string, chromium: boolean): Promise<OutcomeSnapshot | null>;
    /** deviceName undefined reads every device's buffers. */
    collect(deviceName: string | undefined, start: number, end: number): Promise<CollectResult>;
    idleFor(deviceName: string | undefined): IdleDeps;
    now(): number;
}

export interface OutcomeHandle {
    startedAt: number;
    /** The connected app's name when one is connected, else the caller's device argument. */
    deviceName: string | undefined;
    connected: boolean;
    chromium: boolean;
    before: OutcomeSnapshot | null;
    notes: string[];
}

async function defaultResolveApp(device?: string): Promise<{ deviceName: string; chromium: boolean } | null> {
    const chrome = chromiumAppFor("tap", device);
    if (chrome) return { deviceName: chrome.deviceInfo.deviceName, chromium: true };
    // The same target the gesture will use, so a multi-device session reads the right
    // app rather than the first connected one.
    const t = await resolveDeviceTarget(device);
    const key = t.ok ? (t.target.androidSerial ?? t.target.iosUdid ?? t.target.deviceName) : device;
    const r = resolveConnectedAppByDevice(key);
    return r.kind === "ok" ? { deviceName: r.app.deviceInfo.deviceName, chromium: false } : null;
}

async function defaultReadSnapshot(deviceName: string, chromium: boolean): Promise<OutcomeSnapshot | null> {
    if (chromium) {
        const app = getConnectedAppByDevice(deviceName);
        return app ? snapshotFromScreenState(await chromiumScreenState(app)) : null;
    }
    return readTextSnapshot(deviceName);
}

export const defaultOutcomeDeps: OutcomeDeps = {
    resolveApp: defaultResolveApp,
    readSnapshot: defaultReadSnapshot,
    collect: (deviceName, start, end) =>
        collectTimeline({ device: deviceName, sources: ["network", "logs", "restarts"], window: { start, end, label: "action", fallback: false } }),
    idleFor: (deviceName) => ({
        now: () => Date.now(),
        sleep: delay,
        refresh: () => refreshMirror(deviceName),
        requests: () => {
            if (deviceName) return networkBuffers.get(deviceName)?.getAll({}) ?? [];
            return [...networkBuffers.values()].flatMap((b) => b.getAll({}));
        },
    }),
    now: () => Date.now(),
};

async function trySnapshot(h: OutcomeHandle, deps: OutcomeDeps): Promise<OutcomeSnapshot | null> {
    if (!h.connected || !h.deviceName) return null;
    try {
        return await deps.readSnapshot(h.deviceName, h.chromium);
    } catch {
        return null;
    }
}

export async function beginActionOutcome(device: string | undefined, deps: OutcomeDeps = defaultOutcomeDeps): Promise<OutcomeHandle> {
    let app: { deviceName: string; chromium: boolean } | null = null;
    try {
        app = await deps.resolveApp(device);
    } catch {
        app = null;
    }
    const h: OutcomeHandle = {
        startedAt: deps.now(),
        deviceName: app?.deviceName ?? device,
        connected: !!app,
        chromium: app?.chromium ?? false,
        before: null,
        notes: [],
    };
    h.before = await trySnapshot(h, deps);
    // The window starts once the before-read is done, i.e. at the gesture.
    h.startedAt = deps.now();
    return h;
}

export async function finishActionOutcome(
    h: OutcomeHandle,
    opts: { visualSettleRan: boolean },
    deps: OutcomeDeps = defaultOutcomeDeps
): Promise<ActionOutcome> {
    const unavailable: string[] = [];
    let idle = { pending: 0, capped: false };
    try {
        idle = await waitForNetworkIdle(
            { since: h.startedAt - CLOCK_PAD_MS, capAt: h.startedAt + IDLE_CAP_MS, graceMs: opts.visualSettleRan ? 0 : IDLE_GRACE_MS },
            deps.idleFor(h.deviceName)
        );
    } catch {
        // A failed poll only means the wait ended early; the reads below still run.
    }

    let after: OutcomeSnapshot | null = null;
    if (!h.connected) {
        unavailable.push("route", "text: no React Native connection");
    } else {
        after = await trySnapshot(h, deps);
        if (!h.before || !after) unavailable.push("text: snapshot read failed");
    }

    let events: CollectResult["events"] = [];
    try {
        events = (await deps.collect(h.deviceName, h.startedAt - CLOCK_PAD_MS, deps.now())).events;
    } catch {
        unavailable.push("network and logs: read failed");
    }

    return buildOutcome({ before: h.before, after, events, pending: idle.pending, capped: idle.capped, unavailable });
}
