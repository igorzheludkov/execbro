import { networkInterfaces } from "os";

/**
 * Detects that this machine's LAN address changed after a device connected, which is the
 * one disconnect that retrying can never fix.
 *
 * Why this exists. `expo start` (and a dev client launched from its QR/launcher) bakes the
 * machine's LAN IP into the bundle URL. After sleep or a Wi-Fi switch the IP changes, the
 * app keeps dialling the old one, its inspector socket never reaches Metro, and Metro
 * advertises no device. Every reconnect attempt and every scan_metro then says "no
 * debuggable devices" — indistinguishable from a closed app — so the agent gives up.
 * The fix is to point the app at the new address (or localhost), not to retry.
 *
 * Silent unless an address seen at connect time is gone now: a hint on every empty scan
 * would be noise, and a plain closed app must keep its plain message.
 */

type AddressReader = () => string[];

const readLanAddresses: AddressReader = () =>
    Object.values(networkInterfaces())
        .flat()
        .filter(a => a && a.family === "IPv4" && !a.internal)
        .map(a => a!.address);

let reader: AddressReader = readLanAddresses;
let addressesAtConnect: string[] | null = null;

/** Call on every successful (re)connect. */
export function rememberHostAddresses(): void {
    addressesAtConnect = reader();
}

/** A hint when an address the app may be pointed at has disappeared, else null. */
export function hostAddressChangeHint(port = 8081): string | null {
    if (!addressesAtConnect) return null;
    const current = reader();
    const lost = addressesAtConnect.filter(a => !current.includes(a));
    if (lost.length === 0) return null;
    const url = encodeURIComponent(`http://localhost:${port}`);
    return [
        `NETWORK ADDRESS CHANGED: this machine was ${lost.join(", ")} when the app connected and is now ${current.join(", ") || "offline"}.`,
        `The app is most likely still loading from the old address, so retrying scan_metro will not bring it back.`,
        `Reload it from a reachable address, then scan_metro:`,
        `  iOS simulator (Expo dev client): xcrun simctl openurl booted "<app-scheme>://expo-development-client/?url=${url}" and accept the "Open in" prompt`,
        `  Android emulator: adb reverse tcp:${port} tcp:${port}, then relaunch the app`,
        `  Physical device: reopen the project from the dev launcher or a fresh QR code on the new address`,
    ].join("\n");
}

/** Test seam. */
export function resetHostAddress(nextReader: AddressReader = readLanAddresses): void {
    reader = nextReader;
    addressesAtConnect = null;
}
