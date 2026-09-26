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

/** Before document.title is set, Chromium lists a page's URL (scheme dropped), or nothing, as its title. */
export function isUntitledPage(d: DeviceInfo): boolean {
    return !d.title || (d.url ?? "").endsWith(d.title);
}

// Names handed out this session. `byId` keeps a live window's name through
// reloads and title changes. `reserved` remembers which page each name was given
// for, so a closed and reopened window (new target id, same url) gets its name
// back and no other window ever takes it: buffers, epochs and mock rules are
// keyed by name, and must never move to a different window.
// ponytail: grows by one small entry per window ever seen; bound it if a
// session ever opens thousands of tabs.
const byId = new Map<string, string>();
const reserved = new Map<string, { url: string; base: string }>();

/** Test seam. */
export function __resetChromiumNames(): void {
    byId.clear();
    reserved.clear();
}

function baseName(d: DeviceInfo): string {
    return d.title || d.url || "Chromium";
}

/**
 * Fix a window's current name for the rest of the session. Called on connect,
 * because that is when buffers and the registry take the name: a window
 * connected before its title loaded keeps its url name rather than being
 * renamed under the agent on the next scan.
 */
export function pinChromiumName(d: DeviceInfo): void {
    if (!isChromiumTarget(d) || !d.deviceName || byId.has(d.id)) return;
    byId.set(d.id, d.deviceName);
    if (!reserved.has(d.deviceName)) reserved.set(d.deviceName, { url: d.url || "", base: baseName(d) });
}

/**
 * Chromium /json carries no deviceName, which is why the spike printed
 * "Connected to FluentTalk (undefined)". Name each window after its title,
 * suffixing collisions (`FluentTalk`, `FluentTalk#2`). A known window keeps its
 * name; a new one first reclaims a free name reserved for its own url, else
 * takes the first name nobody holds or reserved, in url order, so the same set
 * of windows gets the same names on every fresh start (target ids are random per
 * window, and ordering by them swapped names whenever a window was reopened).
 * An untitled window's name is provisional until it has a title or is connected.
 */
export function nameChromiumTargets(devices: DeviceInfo[]): DeviceInfo[] {
    const chromium = devices.filter((d) => isChromiumTarget(d) && !d.deviceName);
    const live = new Set<string>();
    for (const d of chromium) {
        const known = byId.get(d.id);
        if (known) live.add(known);
    }
    const order = (d: DeviceInfo) => `${d.url || ""}\u0000${d.id}`;
    const fresh = chromium.filter((d) => !byId.has(d.id)).sort((a, b) => (order(a) < order(b) ? -1 : 1));
    for (const d of fresh) {
        const base = baseName(d);
        const url = d.url || "";
        let name = [...reserved].find(([n, r]) => r.url === url && r.base === base && !live.has(n))?.[0];
        if (!name) {
            const free = (n: string) => !live.has(n) && (reserved.get(n)?.url ?? url) === url;
            name = base;
            for (let n = 2; !free(name); n++) name = `${base}#${n}`;
        }
        live.add(name);
        d.deviceName = name;
        if (!isUntitledPage(d)) pinChromiumName(d);
    }
    for (const d of chromium) {
        d.deviceName ||= byId.get(d.id)!;
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
export async function fetchDevices(port: number, titleGraceMs = 1500): Promise<DeviceInfo[]> {
    const deadline = Date.now() + titleGraceMs;
    for (;;) {
        let devices: DeviceInfo[];
        try {
            const response = await fetch(`http://localhost:${port}/json`);
            if (!response.ok) {
                return [];
            }
            // The one reader of /json: filtering here keeps browser internals out of
            // scan, connect_metro, ensure_connection and the reconnect fallback alike.
            devices = keepChromiumPages(((await response.json()) as DeviceInfo[])
                .filter((d) => d.webSocketDebuggerUrl && !isBrowserInternalTarget(d)));
        } catch {
            return [];
        }
        // A window listed before its document.title loaded would be named after its
        // url, and connecting it would pin that name. The title follows within ~300 ms.
        const waiting = devices.some((d) => isChromiumTarget(d) && !d.deviceName && !byId.has(d.id) && isUntitledPage(d));
        if (!waiting || Date.now() >= deadline) return nameChromiumTargets(devices);
        await new Promise((r) => setTimeout(r, 100));
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
 * A port is a Chromium endpoint by what it lists, not by its number: an
 * Electron app can sit inside the Metro range (the spike used 8085). Metro's
 * inspector proxy lists `node` targets only, so one real page settles it.
 */
export function isChromiumListing(devices: DeviceInfo[]): boolean {
    return devices.some(isChromiumTarget);
}

/**
 * On a Chromium endpoint keep only real pages. A target type we do not know
 * (`other`, `assistive_technology`, whatever Chrome adds next) would otherwise
 * connect with the default `android` platform and slip past the gate. A Metro
 * listing is returned untouched.
 */
export function keepChromiumPages(devices: DeviceInfo[]): DeviceInfo[] {
    return isChromiumListing(devices) ? devices.filter(isChromiumTarget) : devices;
}

/**
 * What connect_metro attaches. Metro keeps connect-everything. On a port with
 * several Chromium targets a name is required: connecting injects a network
 * interceptor into the page, so a bare call must not do that to every tab of
 * someone's browser.
 */
export function selectConnectTargets(
    devices: DeviceInfo[],
    device?: string
): { targets: DeviceInfo[] } | { error: string } {
    const available = devices.map((d) => d.deviceName || d.title).join(", ");
    if (device) {
        const wanted = device.toLowerCase();
        const targets = devices.filter((d) => (d.deviceName || d.title || "").toLowerCase().includes(wanted));
        return targets.length > 0 ? { targets } : { error: `No target matches "${device}". Available: ${available}` };
    }
    const chromium = devices.filter(isChromiumTarget);
    if (chromium.length > 1) {
        return {
            error: `${chromium.length} Chromium targets here. Connecting injects a network interceptor into each page, ` +
                `so name the one you want with device="<name>". Available: ${available}`
        };
    }
    return { targets: devices };
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
