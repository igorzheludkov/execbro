import { getConnectedApps } from "./connection.js";
import { listAllDevices } from "./deviceDiscovery.js";
import { listDevices, recordDevice } from "./projectMemory.js";

export type DeviceTargetSource =
    | "registry"
    | "udid"
    | "adb-serial"
    | "name-match"
    | "default";

export interface DeviceTarget {
    platform: "ios" | "android";
    iosUdid?: string;
    androidSerial?: string;
    deviceName: string;
    source: DeviceTargetSource;
}

export type DeviceResolverErrorCode =
    | "MULTIPLE_DEVICES_MATCH"
    | "NO_DEVICES_FOUND"
    | "DEVICE_NOT_FOUND"
    | "SIMULATOR_NOT_BOOTED"
    | "CONFLICTING_IDENTIFIERS";

export interface DeviceResolverError {
    code: DeviceResolverErrorCode;
    message: string;
    candidates?: Array<{ name: string; platform: "ios" | "android"; identifier: string }>;
}

export type ResolveResult =
    | { ok: true; target: DeviceTarget; note?: string }
    | { ok: false; error: DeviceResolverError };

const UDID_REGEX = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ADB_SERIAL_REGEX = /^emulator-\d+$/;

/**
 * Lowercase and strip separators (whitespace, `_`, `-`) so substring matches
 * survive punctuation drift between caller input and the device's reported
 * name (e.g. "SM_A356N" vs "SM-A356N - 15 - API 35").
 */
function normalizeName(value: string | null | undefined): string {
    if (!value) return "";
    return value.toLowerCase().replace(/[\s_\-]+/g, "");
}

function err(
    code: DeviceResolverErrorCode,
    message: string,
    candidates?: DeviceResolverError["candidates"]
): ResolveResult {
    return { ok: false, error: { code, message, candidates } };
}

function ok(target: DeviceTarget): ResolveResult {
    return { ok: true, target };
}

/**
 * Render a DeviceResolverError as a single string suitable for tool responses.
 * Appends the candidates list when present so the agent can disambiguate
 * without an extra list_devices call.
 */
export function formatResolverError(error: DeviceResolverError): string {
    if (!error.candidates || error.candidates.length === 0) return error.message;
    const lines = error.candidates.map(
        (c) => `  - ${c.name} (${c.platform}) → device="${c.identifier}"`
    );
    return `${error.message}\nCandidates:\n${lines.join("\n")}`;
}

/**
 * Resolve a single `device` string (UDID, adb serial, RN-registry deviceName,
 * sim/emu name, or undefined) into a structured DeviceTarget.
 *
 * Resolution order:
 *   1. UDID format → iOS simulator lookup (errors if shutdown).
 *   2. emulator-NNNN format → Android serial lookup.
 *   3. Substring match against the RN-connected registry.
 *   4. Substring match against booted iOS sims and online Android devices.
 *   5. No `device` argument → pick the single running device, or error.
 */
async function resolveDeviceTargetInner(device?: string): Promise<ResolveResult> {
    const trimmed = device?.trim();

    // Step 1: UDID match.
    if (trimmed && UDID_REGEX.test(trimmed)) {
        const inv = await listAllDevices();
        const sim = inv.ios.simulators.find((s) => s.udid.toLowerCase() === trimmed.toLowerCase());
        if (!sim) {
            return err(
                "DEVICE_NOT_FOUND",
                `No iOS simulator with UDID "${trimmed}". Call list_devices to see available identifiers.`
            );
        }
        if (sim.state !== "booted") {
            return err(
                "SIMULATOR_NOT_BOOTED",
                `Simulator "${sim.name}" (${sim.udid}) is not booted. Boot it with ios_boot_simulator({ udid: "${sim.udid}" }).`
            );
        }
        return ok({
            platform: "ios",
            iosUdid: sim.udid,
            deviceName: sim.name,
            source: "udid"
        });
    }

    // Step 2: adb serial format.
    if (trimmed && ADB_SERIAL_REGEX.test(trimmed)) {
        const inv = await listAllDevices();
        const emu = inv.android.emulators.find((e) => e.serial === trimmed);
        if (emu) {
            // Prefer the RN registry's deviceName when an app is connected on
            // this serial — the registry name (e.g. "sdk_gphone16k_arm64 - 16 -
            // API 36") matches what every other code path emits; the AVD
            // identifier ("Pixel_9_-_16kb") is confusing as a response label.
            // OB2 (2026-05-20).
            const registryApp = getConnectedApps().find(
                (e) => e.app.platform === "android" && e.app.adbSerial === trimmed
            );
            return ok({
                platform: "android",
                androidSerial: trimmed,
                deviceName: registryApp?.app.deviceInfo.deviceName || emu.name,
                source: "adb-serial"
            });
        }
        const phys = inv.android.physical.find((p) => p.serial === trimmed);
        if (phys) {
            const registryApp = getConnectedApps().find(
                (e) => e.app.platform === "android" && e.app.adbSerial === trimmed
            );
            return ok({
                platform: "android",
                androidSerial: trimmed,
                deviceName: registryApp?.app.deviceInfo.deviceName || phys.model,
                source: "adb-serial"
            });
        }
        return err(
            "DEVICE_NOT_FOUND",
            `No Android device with serial "${trimmed}". Call list_devices to see attached devices.`
        );
    }

    // Step 3: Registry substring match.
    if (trimmed) {
        const apps = getConnectedApps();
        const needle = normalizeName(trimmed);
        const matches = apps.filter((entry) => {
            const name = normalizeName(entry.app.deviceInfo.deviceName);
            return name.includes(needle);
        });
        if (matches.length === 1) {
            const m = matches[0].app;
            // When the iOS app's UDID hasn't been backfilled yet (the
            // findSimulatorByName race during connection), look it up on
            // demand. Without this, downstream callers default to whichever
            // simulator simctl reports as active — which on a multi-sim
            // setup can be the OTHER device. Bug #5 (2026-05-20).
            let iosUdid = m.simulatorUdid;
            if (m.platform === "ios" && !iosUdid && m.deviceInfo.deviceName) {
                try {
                    const inv = await listAllDevices();
                    const sim = inv.ios.simulators.find(
                        (s) => s.state === "booted" && s.name === m.deviceInfo.deviceName
                    );
                    if (sim) iosUdid = sim.udid;
                } catch {
                    // best-effort; fall through with undefined udid
                }
            }
            return ok({
                platform: m.platform,
                iosUdid,
                androidSerial: m.adbSerial,
                deviceName: m.deviceInfo.deviceName,
                source: "registry"
            });
        }
        if (matches.length > 1) {
            return err(
                "MULTIPLE_DEVICES_MATCH",
                `"${trimmed}" matches multiple connected devices. Pass a more specific identifier (full name, UDID, or adb serial).`,
                matches.map((m) => ({
                    name: m.app.deviceInfo.deviceName,
                    platform: m.app.platform,
                    identifier: m.app.simulatorUdid ?? m.app.adbSerial ?? m.app.deviceInfo.deviceName
                }))
            );
        }
    }

    // Step 4: OS-level name match.
    const inv = await listAllDevices();
    if (trimmed) {
        const needle = normalizeName(trimmed);
        const iosBootedMatches = inv.ios.simulators.filter(
            (s) => s.state === "booted" && normalizeName(s.name).includes(needle)
        );
        const androidRunningMatches = inv.android.emulators.filter(
            (e) => e.state === "running" && normalizeName(e.name).includes(needle)
        );
        const androidPhysicalMatches = inv.android.physical.filter(
            (p) => p.state === "device" && normalizeName(p.model).includes(needle)
        );

        const totalMatches =
            iosBootedMatches.length + androidRunningMatches.length + androidPhysicalMatches.length;

        if (totalMatches === 1) {
            if (iosBootedMatches.length === 1) {
                const s = iosBootedMatches[0];
                return ok({
                    platform: "ios",
                    iosUdid: s.udid,
                    deviceName: s.name,
                    source: "name-match"
                });
            }
            if (androidRunningMatches.length === 1) {
                const e = androidRunningMatches[0];
                return ok({
                    platform: "android",
                    androidSerial: e.serial ?? undefined,
                    deviceName: e.name,
                    source: "name-match"
                });
            }
            const p = androidPhysicalMatches[0];
            return ok({
                platform: "android",
                androidSerial: p.serial,
                deviceName: p.model,
                source: "name-match"
            });
        }
        if (totalMatches > 1) {
            const candidates = [
                ...iosBootedMatches.map((s) => ({ name: s.name, platform: "ios" as const, identifier: s.udid })),
                ...androidRunningMatches.map((e) => ({ name: e.name, platform: "android" as const, identifier: e.serial ?? e.name })),
                ...androidPhysicalMatches.map((p) => ({ name: p.model, platform: "android" as const, identifier: p.serial }))
            ];
            return err(
                "MULTIPLE_DEVICES_MATCH",
                `"${trimmed}" matches multiple devices. Pass a UDID or adb serial to disambiguate.`,
                candidates
            );
        }
        return err(
            "DEVICE_NOT_FOUND",
            `"${trimmed}" did not match any connected RN app, booted simulator, or attached Android device. Call list_devices to enumerate options.`
        );
    }

    // Step 5: No `device` argument — pick the single available device.
    const bootedSims = inv.ios.simulators.filter((s) => s.state === "booted");
    const runningEmus = inv.android.emulators.filter((e) => e.state === "running");
    const onlinePhys = inv.android.physical.filter((p) => p.state === "device");
    const totalRunning = bootedSims.length + runningEmus.length + onlinePhys.length;

    if (totalRunning === 0) {
        // Final fallback: if a single RN app is connected (e.g. physical iOS
        // not in simctl), use it.
        const apps = getConnectedApps();
        if (apps.length === 1) {
            const m = apps[0].app;
            return ok({
                platform: m.platform,
                iosUdid: m.simulatorUdid,
                androidSerial: m.adbSerial,
                deviceName: m.deviceInfo.deviceName,
                source: "default"
            });
        }
        return err(
            "NO_DEVICES_FOUND",
            "No devices found. Boot an iOS simulator or start an Android emulator, then retry."
        );
    }

    if (totalRunning > 1) {
        const candidates = [
            ...bootedSims.map((s) => ({ name: s.name, platform: "ios" as const, identifier: s.udid })),
            ...runningEmus.map((e) => ({ name: e.name, platform: "android" as const, identifier: e.serial ?? e.name })),
            ...onlinePhys.map((p) => ({ name: p.model, platform: "android" as const, identifier: p.serial }))
        ];

        try {
            const remembered = listDevices();
            for (const dev of remembered) {
                const match = candidates.find((c) => c.identifier === dev.identifier);
                if (match) {
                    const day = Number.isFinite(dev.lastUsedAt)
                        ? new Date(dev.lastUsedAt).toISOString().slice(0, 10)
                        : "unknown";
                    return {
                        ok: true,
                        note: `defaulted to ${match.name} (${match.identifier}) — last used ${day}; pass device= to override.`,
                        target: {
                            platform: match.platform,
                            iosUdid: match.platform === "ios" ? match.identifier : undefined,
                            androidSerial: match.platform === "android" ? match.identifier : undefined,
                            deviceName: match.name,
                            source: "default",
                        },
                    };
                }
            }
        } catch {
            // Project-memory lookup must never break device resolution; fall
            // through to the existing MULTIPLE_DEVICES_MATCH error below.
        }

        return err(
            "MULTIPLE_DEVICES_MATCH",
            "Multiple devices available. Specify device='...'. Call list_devices to enumerate.",
            candidates
        );
    }

    if (bootedSims.length === 1) {
        const s = bootedSims[0];
        return ok({ platform: "ios", iosUdid: s.udid, deviceName: s.name, source: "default" });
    }
    if (runningEmus.length === 1) {
        const e = runningEmus[0];
        return ok({
            platform: "android",
            androidSerial: e.serial ?? undefined,
            deviceName: e.name,
            source: "default"
        });
    }
    const p = onlinePhys[0];
    return ok({ platform: "android", androidSerial: p.serial, deviceName: p.model, source: "default" });
}

/**
 * Public resolver: delegates to the inner resolution, then records the resolved
 * device to project memory (best-effort, never throws). The inner function also
 * consults project memory to auto-default on no-hint ambiguity (see Step 5).
 */
export async function resolveDeviceTarget(device?: string): Promise<ResolveResult> {
    const result = await resolveDeviceTargetInner(device);
    if (result.ok) {
        try {
            const t = result.target;
            const identifier = t.iosUdid ?? t.androidSerial ?? t.deviceName;
            let appId: string | undefined;
            try {
                appId = getConnectedApps().find(
                    (e) =>
                        e.app.simulatorUdid === identifier ||
                        e.app.adbSerial === identifier ||
                        e.app.deviceInfo.deviceName === t.deviceName,
                )?.app.deviceInfo.appId;
            } catch {
                // registry lookup is best-effort
            }
            recordDevice({ identifier, name: t.deviceName, platform: t.platform, appId });
        } catch {
            // recording must never affect resolution
        }
    }
    return result;
}
