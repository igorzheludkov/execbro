import { listIOSSimulators } from "./ios.js";
import { listAndroidDevices, getAndroidEmulatorAvds, getAdbIdForAvd } from "./android.js";

export interface IosSimulatorRow {
    name: string;
    udid: string;
    state: "booted" | "shutdown";
    runtime: string;
    rnConnected?: { deviceName: string; port: number };
}

export interface AndroidEmulatorRow {
    name: string;
    serial: string | null;
    state: "running" | "stopped";
    rnConnected?: { deviceName: string; port: number };
}

export interface AndroidPhysicalRow {
    model: string;
    serial: string;
    state: "device" | "unauthorized" | "offline";
    rnConnected?: { deviceName: string; port: number };
}

export interface ListAllDevicesResult {
    ios: {
        available: boolean;
        error?: string;
        simulators: IosSimulatorRow[];
    };
    android: {
        available: boolean;
        error?: string;
        emulators: AndroidEmulatorRow[];
        physical: AndroidPhysicalRow[];
    };
    summary: { booted: number; total: number };
}

const CACHE_TTL_MS = 5000;
let cache: { result: ListAllDevicesResult; timestamp: number } | null = null;

/** Test-only: clear the cache so the next call re-queries. */
export function resetDeviceDiscoveryCache(): void {
    cache = null;
}

async function discoverIos(): Promise<ListAllDevicesResult["ios"]> {
    const result = await listIOSSimulators(false);
    if (!result.success) {
        return { available: false, error: result.error, simulators: [] };
    }
    const simulators: IosSimulatorRow[] = (result.simulators ?? []).map((sim) => ({
        name: sim.name,
        udid: sim.udid,
        state: sim.state === "Booted" ? "booted" : "shutdown",
        runtime: sim.runtime
    }));
    return { available: true, simulators };
}

async function discoverAndroid(): Promise<ListAllDevicesResult["android"]> {
    const devicesResult = await listAndroidDevices();
    if (!devicesResult.success) {
        return {
            available: false,
            error: devicesResult.error,
            emulators: [],
            physical: []
        };
    }

    const rawDevices = devicesResult.devices ?? [];
    const physical: AndroidPhysicalRow[] = rawDevices
        .filter((d) => !/^emulator-\d+$/.test(d.id))
        .map((d) => ({
            model: d.model ?? d.id,
            serial: d.id,
            state: (d.status as AndroidPhysicalRow["state"]) ?? "offline"
        }));

    const avds = await getAndroidEmulatorAvds();
    const emulators: AndroidEmulatorRow[] = await Promise.all(
        avds.map(async (name) => {
            const serial = await getAdbIdForAvd(name);
            return {
                name,
                serial,
                state: serial ? "running" : "stopped"
            } as AndroidEmulatorRow;
        })
    );

    return { available: true, emulators, physical };
}

function computeSummary(result: Omit<ListAllDevicesResult, "summary">): ListAllDevicesResult["summary"] {
    const iosBooted = result.ios.simulators.filter((s) => s.state === "booted").length;
    const androidRunning = result.android.emulators.filter((e) => e.state === "running").length;
    const androidPhysicalOnline = result.android.physical.filter((p) => p.state === "device").length;
    const booted = iosBooted + androidRunning + androidPhysicalOnline;
    const total =
        result.ios.simulators.length +
        result.android.emulators.length +
        result.android.physical.length;
    return { booted, total };
}

export interface ListAllDevicesOptions {
    refresh?: boolean;
}

export async function listAllDevices(
    options: ListAllDevicesOptions = {}
): Promise<ListAllDevicesResult> {
    if (!options.refresh && cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
        return cache.result;
    }

    const [ios, android] = await Promise.all([discoverIos(), discoverAndroid()]);
    const partial = { ios, android };
    const result: ListAllDevicesResult = {
        ...partial,
        summary: computeSummary(partial)
    };
    cache = { result, timestamp: Date.now() };
    return result;
}
