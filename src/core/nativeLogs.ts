import { connectedApps } from "./state.js";
import { listDevices, recordDevice } from "./projectMemory.js";
import { listAllDevices } from "./deviceDiscovery.js";
import { execFileAsync } from "./exec.js";
import {
    getNativeLogBuffer,
    LEVEL_RANK,
    type AppIdentity,
    type DraftEvent,
    type LogEvent,
    type EventLevel,
    type RawLogLine,
} from "./logEvents.js";
import { isOwned } from "./logOwnership.js";
import { groupIntoEvents } from "./logGrouping.js";
import { isRelevant } from "./logRelevance.js";
import { fetchAndroidLines, resolveAndroidPid } from "./logSourceAndroid.js";
import { fetchIosLines, resolveIosProcessName } from "./logSourceIos.js";
import type { ConnectedApp } from "./types.js";

/** simulatorUdid ?? adbSerial. Never deviceName — two sims can share a name. */
export function deviceKeyOf(app: ConnectedApp): string | undefined {
    return app.simulatorUdid ?? app.adbSerial;
}

/**
 * Build identity for a connected app. iOS bundle ids and Android package names
 * differ for the same product, so this is always per-device and never global.
 *
 * `deviceKeyOverride` covers apps found via `matchAndroidAppBySerial`: their
 * OWN `adbSerial` is exactly the null value that made the direct lookup miss
 * in the first place, so `deviceKeyOf(app)` would still fail here — the
 * caller passes the discovered device's serial instead, which is what the
 * native buffer is actually keyed by.
 */
export function identityFromApp(
    app: ConnectedApp,
    deviceKeyOverride?: string
): AppIdentity | undefined {
    const deviceKey = deviceKeyOverride ?? deviceKeyOf(app);
    if (!deviceKey || !app.deviceInfo.appId) return undefined;
    return { deviceKey, platform: app.platform, appId: app.deviceInfo.appId };
}

/**
 * Last-known identity for a device that is no longer connected — the crash
 * case, where there is no ConnectedApp to read appId from.
 *
 * Residual limitation: this can only find an appId that was previously
 * recorded under `deviceKey` or `deviceName`. `resolveLogTargets` writes the
 * live identity under `deviceKey` (the udid / adb serial) via `recordDevice`
 * while the app is connected, which is what makes this succeed after a
 * crash — but if the app has never been connected on this device in this
 * project, there is nothing to find. That is a designed degradation, not a
 * bug: the device still runs in crash-buffer-only mode, and crashes still
 * surface with their declared owner.
 */
export function identityFromMemory(
    deviceKey: string,
    platform: "ios" | "android",
    deviceName?: string
): AppIdentity | undefined {
    const devices = listDevices();
    // projectMemory records a device under whichever identifier the resolving
    // caller used — the adb serial on some paths, the RN deviceName on others —
    // so one physical device can hold two entries with only one carrying the
    // appId. Both keys must be tried, and a matching row with no appId must not
    // shadow one that has it, or this fallback never fires on Android.
    const remembered =
        devices.find((d) => d.identifier === deviceKey && d.appId) ??
        (deviceName ? devices.find((d) => d.identifier === deviceName && d.appId) : undefined);
    if (!remembered?.appId) return undefined;
    return { deviceKey, platform, appId: remembered.appId };
}

/**
 * ownership -> grouping -> relevance -> ingest.
 *
 * Relevance runs after grouping because it tests `kind`, which the grouper
 * assigns; a floor applied to raw lines would shred backtrace continuations.
 */
export function runNativePipeline(
    lines: RawLogLine[],
    identity: AppIdentity,
    deviceName: string,
    opts: { minLevel: EventLevel }
): { events: LogEvent[]; belowFloor?: BelowFloor } {
    const owned = lines.filter((l) => isOwned(l, identity).owned);
    const drafts = groupIntoEvents(owned, {
        deviceKey: identity.deviceKey,
        deviceName,
        source: "native",
    });
    const relevant = drafts.filter((d) => isRelevant(d, { minLevel: opts.minLevel }));
    return {
        events: getNativeLogBuffer(identity.deviceKey).ingest(relevant),
        // Judged on the FILTER's outcome, not on what ingest returned: an
        // inclusive refetch legitimately ingests nothing, and blaming the
        // floor for that would send the caller after events they already have.
        belowFloor: relevant.length === 0 ? describeBelowFloor(drafts) : undefined,
    };
}

/** What a severity floor hid, when it hid everything. */
export interface BelowFloor {
    /** Events fetched and grouped, then dropped by the floor. */
    count: number;
    /**
     * The highest tier among them — i.e. the highest floor that still admits
     * something. Suggesting anything lower would be needlessly noisy;
     * suggesting anything higher would return the same emptiness again.
     */
    suggestedLevel: EventLevel;
}

/**
 * Only events that REACHED the floor count. Lines dropped by ownership never
 * did, so a device whose whole output belonged to another app must not be
 * reported as "filtered out" — the retry would be identical.
 */
function describeBelowFloor(dropped: DraftEvent[]): BelowFloor | undefined {
    if (dropped.length === 0) return undefined;
    let suggestedLevel = dropped[0].level;
    for (const d of dropped) {
        if (LEVEL_RANK[d.level] > LEVEL_RANK[suggestedLevel]) suggestedLevel = d.level;
    }
    return { count: dropped.length, suggestedLevel };
}

export interface LogTarget {
    /** simulatorUdid (iOS) | adb serial (Android). The buffer key. */
    deviceKey: string;
    deviceName: string;
    platform: "ios" | "android";
    /** Android only — what `adb -s` accepts. */
    adbSerial?: string;
    /** Absent when the app has never connected on this device. */
    identity?: AppIdentity;
    /** Where `identity` came from — memory-sourced ids can be stale. */
    identitySource?: "live" | "memory";
}

/**
 * Find the ConnectedApp for a discovered Android device.
 *
 * ConnectedApp.adbSerial is frequently null — types.ts documents it as only
 * populated when getAdbIdForAvd happens to match at connect time — so keying
 * on it alone means Android never gets live identity, and every Android read
 * silently degrades to crash-buffer-only. The three Android names (adb serial,
 * AVD name, RN/Metro deviceName) do not join, and resolveDeviceTarget cannot
 * bridge them either.
 *
 * Metro labels Android targets `${MODEL} - ${RELEASE} - API ${SDK}`, so
 * ro.product.model is a deterministic prefix of the RN deviceName. Verified
 * live: model "sdk_gphone16k_arm64" vs "sdk_gphone16k_arm64 - 16 - API 36".
 */
async function matchAndroidAppBySerial(
    serial: string,
    apps: ConnectedApp[]
): Promise<ConnectedApp | undefined> {
    const candidates = apps.filter((a) => a.platform === "android");
    if (candidates.length === 0) return undefined;
    try {
        const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", "getprop ro.product.model"]);
        const model = stdout.trim();
        if (!model) return undefined;
        return candidates.find((a) => (a.deviceInfo.deviceName ?? "").startsWith(model));
    } catch {
        // Best-effort: fall through to memory / crash-only as before.
        return undefined;
    }
}

/**
 * Every device we could read logs from — NOT just connected ones.
 *
 * A crashed app has no CDP connection, so connectedApps is empty exactly when
 * this feature is most needed. Discovery is the source of truth for "which
 * devices exist"; connectedApps and projectMemory only enrich them with
 * identity. Shutdown simulators and stopped emulators are excluded — there is
 * no log stream to read.
 */
export async function resolveLogTargets(device?: string): Promise<LogTarget[]> {
    const connected = new Map<string, ConnectedApp>();
    for (const app of connectedApps.values()) {
        const key = deviceKeyOf(app);
        if (key) connected.set(key, app);
    }

    const discovered = await listAllDevices();
    const rows: Array<{ deviceKey: string; name: string; platform: "ios" | "android"; adbSerial?: string }> = [];

    for (const sim of discovered.ios.simulators) {
        if (sim.state !== "booted") continue;
        rows.push({ deviceKey: sim.udid, name: sim.name, platform: "ios" });
    }
    for (const emu of discovered.android.emulators) {
        if (emu.state !== "running" || !emu.serial) continue;
        rows.push({ deviceKey: emu.serial, name: emu.name, platform: "android", adbSerial: emu.serial });
    }
    for (const phys of discovered.android.physical) {
        if (phys.state !== "device") continue;
        rows.push({ deviceKey: phys.serial, name: phys.model, platform: "android", adbSerial: phys.serial });
    }

    const targets: LogTarget[] = [];
    for (const row of rows) {
        let app = connected.get(row.deviceKey);
        // adbSerial is frequently null (see matchAndroidAppBySerial), so the
        // serial-keyed lookup above routinely misses even a live app. Fall
        // back to the deterministic model-prefix match before giving up —
        // note the matched app's OWN adbSerial is still null, so its identity
        // must be keyed by row.deviceKey, not recomputed from the app itself.
        let matchedByModel = false;
        if (!app && row.platform === "android") {
            app = await matchAndroidAppBySerial(row.deviceKey, [...connectedApps.values()]);
            matchedByModel = app !== undefined;
        }
        const deviceName = app?.deviceInfo.deviceName || row.name || row.deviceKey;

        if (device) {
            const hay = `${deviceName} ${row.deviceKey}`.toLowerCase();
            if (!hay.includes(device.toLowerCase())) continue;
        }

        // Chain: live connection -> remembered -> none (crash-buffer-only).
        const live = app
            ? identityFromApp(app, matchedByModel ? row.deviceKey : undefined)
            : undefined;
        if (live) {
            // Persist identity under the SAME key the native buffer uses (udid /
            // adb serial). projectMemory is otherwise keyed by whatever
            // identifier the resolving caller happened to use — on Android the
            // appId-bearing row is keyed by the RN deviceName, which nothing
            // links back to the serial. Recording it here while the app is alive
            // is what lets identity survive the crash we later want to explain.
            recordDevice({
                identifier: row.deviceKey,
                name: deviceName,
                platform: row.platform,
                appId: live.appId,
            });
        }
        const remembered = live
            ? undefined
            : identityFromMemory(row.deviceKey, row.platform, row.name);

        targets.push({
            deviceKey: row.deviceKey,
            deviceName,
            platform: row.platform,
            adbSerial: row.adbSerial ?? app?.adbSerial,
            identity: live ?? remembered,
            identitySource: live ? "live" : remembered ? "memory" : undefined,
        });
    }
    return targets;
}

async function fetchForTarget(
    target: LogTarget,
    opts: { minLevel: EventLevel; since?: Date }
): Promise<{ events: LogEvent[]; notes: string[]; belowFloor?: BelowFloor }> {
    const buffer = getNativeLogBuffer(target.deviceKey);
    const sinceTs = opts.since ?? buffer.watermark;

    try {
        if (!target.identity) {
            // Crash-buffer-only: no identity, so no ownership filtering is
            // possible. That buffer is tiny and near-100% signal, and each
            // event names its own owner, so this stays useful.
            const lines = target.platform === "android"
                ? await fetchAndroidLines({ serial: target.adbSerial, sinceTs, crashOnly: true })
                : await fetchIosLines({ udid: target.deviceKey, sinceTs, minMessageType: "fault" });
            const drafts = groupIntoEvents(lines, {
                deviceKey: target.deviceKey,
                deviceName: target.deviceName,
                source: "native",
            }).filter((d) => d.kind === "crash" || d.kind === "anr");
            return {
                events: buffer.ingest(drafts),
                notes: [`${target.deviceName}: no app identity known — showing crashes only`],
            };
        }

        const identity = { ...target.identity };
        let lines: RawLogLine[];
        if (target.platform === "android") {
            // Re-resolved every call: the pid changes on every app restart,
            // and is absent entirely after a crash.
            identity.pid = await resolveAndroidPid(identity.appId, target.adbSerial);
            lines = await fetchAndroidLines({ serial: target.adbSerial, sinceTs });
        } else {
            const processName = await resolveIosProcessName(target.deviceKey, identity.appId);
            lines = await fetchIosLines({ udid: target.deviceKey, processName, sinceTs });
        }
        const result = runNativePipeline(lines, identity, target.deviceName, { minLevel: opts.minLevel });
        const notes: string[] = [];
        if (target.identitySource === "memory") {
            notes.push(`${target.deviceName}: app identity "${identity.appId}" came from project memory (app not currently connected) — if this is stale, events will be filtered out`);
        }
        if (result.belowFloor) {
            // Without this, "the floor hid everything" and "the device was
            // silent" render as the same empty result — the reported bug.
            // Both notes can apply at once: they name different reasons the
            // read came back empty, and each points somewhere different.
            const { count, suggestedLevel } = result.belowFloor;
            notes.push(
                `${target.deviceName}: ${count} event${count === 1 ? "" : "s"} fetched, ` +
                `all below minLevel="${opts.minLevel}" — retry with minLevel="${suggestedLevel}" to see them`
            );
        }
        return { events: result.events, notes, belowFloor: result.belowFloor };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { events: [], notes: [`${target.deviceName}: unavailable (${reason})`] };
    }
}

/**
 * Fan out across every device in parallel. A device that fails degrades to a
 * note; the others still answer.
 */
export async function collectNativeEvents(opts: {
    device?: string;
    minLevel: EventLevel;
    since?: Date;
}): Promise<{ events: LogEvent[]; notes: string[]; belowFloor?: BelowFloor }> {
    const targets = await resolveLogTargets(opts.device);
    if (targets.length === 0) {
        return { events: [], notes: ["No iOS simulators or Android devices found."] };
    }

    const settled = await Promise.allSettled(targets.map((t) => fetchForTarget(t, opts)));

    const events: LogEvent[] = [];
    const notes: string[] = [];
    let belowFloor: BelowFloor | undefined;
    for (const result of settled) {
        if (result.status === "fulfilled") {
            events.push(...result.value.events);
            notes.push(...result.value.notes);
            // Merged across devices: the caller's floor is one setting for the
            // whole read, so the suggestion has to clear the highest tier any
            // device had hidden — a lower one would still hide that device.
            const dropped = result.value.belowFloor;
            if (dropped) {
                belowFloor = belowFloor
                    ? {
                        count: belowFloor.count + dropped.count,
                        suggestedLevel: LEVEL_RANK[dropped.suggestedLevel] > LEVEL_RANK[belowFloor.suggestedLevel]
                            ? dropped.suggestedLevel
                            : belowFloor.suggestedLevel,
                    }
                    : dropped;
            }
        } else {
            notes.push(`device unavailable: ${String(result.reason)}`);
        }
    }
    // Exact within a device, approximate across devices — emulator clocks
    // measured 4s of skew from the host, which we cannot correct for.
    events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return { events, notes, belowFloor };
}
