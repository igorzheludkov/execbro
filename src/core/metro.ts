import * as net from "net";
import { DeviceInfo } from "./types.js";

// Default Metro scan range: ten contiguous ports from 8081.
//
// The previous list was [8081, 8082, 19000, 19001, 19002] — a gap that made a
// third Metro instance on 8083 invisible to a default scan while the scan still
// reported success. Running three or more apps side by side is ordinary now, and
// Metro allocates upward from 8081, so contiguity matters more than the Expo
// 19xxx ports, which modern Expo no longer uses for the bundler.
export const DEFAULT_START_PORT = 8081;
export const DEFAULT_END_PORT = 8090;
export const COMMON_PORTS = Array.from(
    { length: DEFAULT_END_PORT - DEFAULT_START_PORT + 1 },
    (_, i) => DEFAULT_START_PORT + i
);

// Check if a port is open
export async function isPortOpen(port: number, host: string = "localhost"): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on("connect", () => {
            socket.destroy();
            resolve(true);
        });

        socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
        });

        socket.on("error", () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, host);
    });
}

// Scan for running Metro servers
export async function scanMetroPorts(
    startPort: number = DEFAULT_START_PORT,
    endPort: number = DEFAULT_END_PORT
): Promise<number[]> {
    // The default range is contiguous, so there is no longer a special case —
    // generating the range always yields the same ports the default would.
    const portsToCheck = Array.from({ length: endPort - startPort + 1 }, (_, i) => startPort + i);

    const openPorts: number[] = [];

    for (const port of portsToCheck) {
        if (await isPortOpen(port)) {
            openPorts.push(port);
        }
    }

    return openPorts;
}

// Fetch connected devices from Metro /json endpoint
export async function fetchDevices(port: number): Promise<DeviceInfo[]> {
    try {
        const response = await fetch(`http://localhost:${port}/json`);
        if (!response.ok) {
            return [];
        }
        const devices = (await response.json()) as DeviceInfo[];
        return devices.filter((d) => d.webSocketDebuggerUrl);
    } catch {
        return [];
    }
}

// Select the main JS runtime device from a list of devices (priority order)
export function selectMainDevice(devices: DeviceInfo[]): DeviceInfo | null {
    if (devices.length === 0) {
        return null;
    }

    return (
        // SDK 54+ uses "React Native Bridgeless" in description
        devices.find((d) => d.description.includes("React Native Bridgeless")) ||
        // Hermes runtime (RN 0.70+)
        devices.find((d) => d.title === "Hermes React Native" || d.title.includes("Hermes")) ||
        // Fallback: any React Native in title, excluding Reanimated/Experimental
        devices.find(
            (d) =>
                d.title.includes("React Native") &&
                !d.title.includes("Reanimated") &&
                !d.title.includes("Experimental")
        ) ||
        devices[0]
    );
}

export function filterBridgelessDevices(devices: DeviceInfo[]): DeviceInfo[] {
    return devices.filter(d => d.description.includes("React Native Bridgeless"));
}

/**
 * Select the best debuggable target per physical device.
 * Uses the same priority as selectMainDevice but groups by deviceName
 * so multi-device setups get one target each.
 * Excludes Reanimated/Experimental targets.
 */
export function filterDebuggableDevices(devices: DeviceInfo[]): DeviceInfo[] {
    // Group by physical device
    const byDevice = new Map<string, DeviceInfo[]>();
    for (const d of devices) {
        const name = d.deviceName || d.title;
        const group = byDevice.get(name) || [];
        group.push(d);
        byDevice.set(name, group);
    }

    // Pick the best target for each physical device (same priority as selectMainDevice)
    const result: DeviceInfo[] = [];
    for (const group of byDevice.values()) {
        const best = selectMainDevice(group);
        if (best) {
            result.push(best);
        }
    }
    return result;
}

// Scan for Metro and return all devices grouped by port
export async function discoverMetroDevices(
    startPort: number = DEFAULT_START_PORT,
    endPort: number = DEFAULT_END_PORT
): Promise<Map<number, DeviceInfo[]>> {
    const openPorts = await scanMetroPorts(startPort, endPort);
    const result = new Map<number, DeviceInfo[]>();

    for (const port of openPorts) {
        const devices = await fetchDevices(port);
        if (devices.length > 0) {
            result.set(port, devices);
        }
    }

    return result;
}

/**
 * Metro state for fallback detection
 */
export interface MetroState {
    metroRunning: boolean;
    metroPorts: number[];
    hasConnectedApps: boolean;
    /** True when Metro is running but no apps are connected (likely bundle error) */
    needsFallback: boolean;
}

/**
 * Check if Metro is running but no devices/apps are connected
 * This state indicates a possible bundle error preventing the app from loading
 */
export async function checkMetroState(
    connectedAppsCount: number,
    startPort: number = DEFAULT_START_PORT,
    endPort: number = DEFAULT_END_PORT
): Promise<MetroState> {
    const openPorts = await scanMetroPorts(startPort, endPort);
    const metroRunning = openPorts.length > 0;
    const hasConnectedApps = connectedAppsCount > 0;

    // Metro is running but we have no connected apps - possible bundle error
    const needsFallback = metroRunning && !hasConnectedApps;

    return {
        metroRunning,
        metroPorts: openPorts,
        hasConnectedApps,
        needsFallback
    };
}
