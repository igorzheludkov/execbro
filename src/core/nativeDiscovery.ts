/**
 * Finds native Android apps running execbro-sdk-android: every such app holds
 * an abstract socket named execbro_<package>, listed in /proc/net/unix.
 */

import { execFileAsync } from "./exec.js";
import { isAdbAvailable, listAndroidDevices } from "./android.js";
import { connectNativeApp } from "./nativeConnection.js";
import type { ConnectedApp } from "./types.js";

const SOCKET_RE = /\s@execbro_([A-Za-z0-9_.]+)\s*$/;

export function parseExecbroSockets(procNetUnix: string): string[] {
    const found = new Set<string>();
    for (const line of procNetUnix.split("\n")) {
        const m = line.match(SOCKET_RE);
        if (m) found.add(m[1]);
    }
    return [...found];
}

export async function discoverNativeApps(): Promise<Array<{ serial: string; pkg: string }>> {
    const list = await listAndroidDevices();
    if (!list.success || !list.devices) return [];
    const online = list.devices.filter((d) => d.status === "device").map((d) => d.id);
    const perDevice = await Promise.all(
        online.map(async (serial) => {
            try {
                const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", "cat", "/proc/net/unix"], {
                    timeout: 5000,
                    maxBuffer: 16 * 1024 * 1024
                });
                return parseExecbroSockets(stdout).map((pkg) => ({ serial, pkg }));
            } catch {
                return [];
            }
        })
    );
    return perDevice.flat();
}

export interface DiscoveryDeps {
    adbAvailable: () => Promise<boolean>;
    discover: () => Promise<Array<{ serial: string; pkg: string }>>;
    connect: (serial: string, pkg: string) => Promise<ConnectedApp>;
}

const defaultDeps: DiscoveryDeps = {
    adbAvailable: isAdbAvailable,
    discover: discoverNativeApps,
    connect: connectNativeApp
};

/**
 * Connects every SDK app found on every online adb device. Silent (no lines,
 * no adb-missing notice) when adb is absent: most React Native sessions never
 * touch Android and must not see a warning caused by this scan.
 */
export async function discoverAndConnectNativeApps(overrides: Partial<DiscoveryDeps> = {}): Promise<string[]> {
    const deps = { ...defaultDeps, ...overrides };
    if (!(await deps.adbAvailable())) return [];
    const lines: string[] = [];
    for (const { serial, pkg } of await deps.discover()) {
        try {
            const app = await deps.connect(serial, pkg);
            lines.push(`Android native (${serial}): connected to ${app.deviceInfo.deviceName} (${pkg}) via execbro-sdk-android`);
        } catch (e) {
            lines.push(`Android native (${serial}): found ${pkg} but could not connect: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return lines;
}

/** connect_metro({ device: "<package>" }) fallback for devices whose /proc/net/unix is unreadable. */
export async function connectNativePackage(pkg: string): Promise<string[]> {
    if (!(await isAdbAvailable())) return [];
    const list = await listAndroidDevices();
    const online = (list.devices ?? []).filter((d) => d.status === "device").map((d) => d.id);
    return discoverAndConnectNativeApps({ discover: async () => online.map((serial) => ({ serial, pkg })) });
}
