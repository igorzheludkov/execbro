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

// Chromium (Electron / Chrome) remote-debugging port. Same default as argent's
// ARGENT_CHROMIUM_PORTS so knowledge transfers between the two tools.
export const CHROMIUM_DEFAULT_PORT = 9222;

const EXCLUDED_PAGE_SCHEMES = ["chrome://", "chrome-extension://", "devtools://"];

// Chromium target types that are never an app page. Unknown types are NOT in
// here on purpose: an unrecognised type falls through to today's behaviour
// rather than hiding a Metro target we have not seen before.
const BROWSER_INTERNAL_TYPES = new Set([
    "background_page", "service_worker", "shared_worker", "worker",
    "browser_ui", "iframe", "webview", "auction_worklet", "shared_storage_worklet", "tab",
]);

function hasReactNativeMarker(d: DeviceInfo): boolean {
    const title = d.title || "";
    return (d.description || "").includes("React Native") || title.includes("React Native") || title.includes("Hermes");
}

function hasExcludedScheme(d: DeviceInfo): boolean {
    const url = d.url || "";
    return EXCLUDED_PAGE_SCHEMES.some((s) => url.startsWith(s));
}

/**
 * An Electron BrowserWindow or a Chrome tab. A DevTools window is itself a
 * `page`, so the scheme check is what keeps execbro off the user's own DevTools.
 */
export function isChromiumTarget(d: DeviceInfo): boolean {
    return d.type === "page" && !hasReactNativeMarker(d) && !hasExcludedScheme(d);
}

/** Extension pages, service workers, omnibox popups, DevTools windows. */
export function isBrowserInternalTarget(d: DeviceInfo): boolean {
    if (hasReactNativeMarker(d)) return false;
    if (BROWSER_INTERNAL_TYPES.has(d.type)) return true;
    return d.type === "page" && hasExcludedScheme(d);
}

// Names already handed out, by target id + title. A window keeps its name for
// as long as it lives, so opening a same-titled window never renames one that
// is connected (buffers and `device` matching are keyed by name).
// ponytail: grows by one small entry per window ever seen; bound it if a
// session ever opens thousands of tabs.
const chromiumNames = new Map<string, string>();

/**
 * Chromium /json carries no deviceName, which is why the spike printed
 * "Connected to FluentTalk (undefined)". Name each window after its title,
 * suffixing collisions (`FluentTalk`, `FluentTalk#2`). Known windows keep their
 * name; new ones are named in target-id order so a fetch's listing order (Chrome
 * lists most-recent first) never decides who gets the plain name.
 */
export function nameChromiumTargets(devices: DeviceInfo[]): DeviceInfo[] {
    const chromium = devices.filter((d) => isChromiumTarget(d) && !d.deviceName)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const key = (d: DeviceInfo) => `${d.id}\u0000${d.title || d.url || "Chromium"}`;
    const taken = new Set<string>();
    for (const d of chromium) {
        const known = chromiumNames.get(key(d));
        if (known) taken.add(known);
    }
    for (const d of chromium) {
        let name = chromiumNames.get(key(d));
        if (!name) {
            const base = d.title || d.url || "Chromium";
            name = base;
            for (let n = 2; taken.has(name); n++) name = `${base}#${n}`;
            chromiumNames.set(key(d), name);
        }
        taken.add(name);
        d.deviceName = name;
        if (!d.appId) d.appId = d.url || "";
    }
    return devices;
}

/**
 * Chromium ports to probe in addition to the Metro range. Ports named in
 * EXECBRO_CHROMIUM_PORTS were chosen by the user and auto-connect. 9222 is the
 * shared convention where anyone's ad-hoc Chrome lives, and connecting injects
 * a network interceptor into the page, so there it is discover-only unless named.
 */
export function chromiumScanPorts(env: NodeJS.ProcessEnv = process.env): Array<{ port: number; autoConnect: boolean }> {
    const configured: number[] = [];
    for (const raw of (env.EXECBRO_CHROMIUM_PORTS || "").split(",")) {
        const port = Number(raw.trim());
        if (Number.isInteger(port) && port > 0 && port <= 65535 && !configured.includes(port)) configured.push(port);
    }
    const result = configured.map((port) => ({ port, autoConnect: true }));
    if (!configured.includes(CHROMIUM_DEFAULT_PORT)) result.push({ port: CHROMIUM_DEFAULT_PORT, autoConnect: false });
    return result;
}

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
        // The one reader of /json: filtering here keeps browser internals out of
        // scan, connect_metro, ensure_connection and the reconnect fallback alike.
        return nameChromiumTargets(devices.filter((d) => d.webSocketDebuggerUrl && !isBrowserInternalTarget(d)));
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

/**
 * The target to reattach to after a drop. RN keeps its old fallback to the main
 * device, since a reloaded runtime gets a new id. A Chromium target that has gone
 * (tab or window closed) is gone: falling back would attach to, and inject the
 * network interceptor into, some other page nobody chose.
 */
export function pickReconnectTarget(devices: DeviceInfo[], previous: DeviceInfo): DeviceInfo | null {
    const same = devices.find((d) => d.id === previous.id);
    if (same) return same;
    if (isChromiumTarget(previous)) return null;
    return selectMainDevice(devices);
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
