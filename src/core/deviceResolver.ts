import { getConnectedApps } from "./connection.js";
import { listAllDevices } from "./deviceDiscovery.js";

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
    | { ok: true; target: DeviceTarget }
    | { ok: false; error: DeviceResolverError };

const UDID_REGEX = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ADB_SERIAL_REGEX = /^emulator-\d+$/;

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
export async function resolveDeviceTarget(device?: string): Promise<ResolveResult> {
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
        const needle = trimmed.toLowerCase();
        const matches = apps.filter((entry) => {
            const name = entry.app.deviceInfo.deviceName?.toLowerCase() ?? "";
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
        const needle = trimmed.toLowerCase();
        const iosBootedMatches = inv.ios.simulators.filter(
            (s) => s.state === "booted" && s.name.toLowerCase().includes(needle)
        );
        const androidRunningMatches = inv.android.emulators.filter(
            (e) => e.state === "running" && e.name.toLowerCase().includes(needle)
        );
        const androidPhysicalMatches = inv.android.physical.filter(
            (p) => p.state === "device" && p.model.toLowerCase().includes(needle)
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
