import * as net from "net";
import { DeviceInfo } from "./types.js";

// Common Metro ports
export const COMMON_PORTS = [8081, 8082, 19000, 19001, 19002];

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
    startPort: number = 8081,
    endPort: number = 19002
): Promise<number[]> {
    const portsToCheck =
        startPort === 8081 && endPort === 19002
            ? COMMON_PORTS
            : Array.from({ length: endPort - startPort + 1 }, (_, i) => startPort + i);

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

// Scan for Metro and return all devices grouped by port
export async function discoverMetroDevices(
    startPort: number = 8081,
    endPort: number = 19002
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
