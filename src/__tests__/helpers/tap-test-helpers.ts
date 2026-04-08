// src/__tests__/helpers/tap-test-helpers.ts
import { scanMetroPorts, fetchDevices, selectMainDevice } from "../../core/metro.js";
import { connectToDevice } from "../../core/connection.js";
import { executeInApp } from "../../core/executor.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { cancelAllReconnectionTimers, clearAllConnectionState } from "../../core/connectionState.js";
import type { TapResult } from "../../pro/tap.js";

export type Platform = "ios" | "android";

/**
 * Detect which platform is available by checking for booted simulators/emulators.
 * Returns the first available platform.
 */
export async function detectPlatform(): Promise<Platform> {
    const { execSync } = await import("child_process");
    try {
        const result = execSync("xcrun simctl list devices booted 2>/dev/null", { encoding: "utf-8" });
        if (result.includes("Booted")) return "ios";
    } catch { /* no iOS */ }
    try {
        const result = execSync("adb devices 2>/dev/null", { encoding: "utf-8" });
        const lines = result.trim().split("\n").filter(l => l.includes("device") && !l.includes("List"));
        if (lines.length > 0) return "android";
    } catch { /* no Android */ }
    throw new Error("No booted iOS simulator or Android emulator found");
}

/**
 * Connect to Metro and return the platform of the connected device.
 */
export async function connectToMetro(): Promise<Platform> {
    const ports = await scanMetroPorts();
    if (ports.length === 0) {
        throw new Error("No Metro bundler found. Start Metro with the test app first.");
    }

    for (const port of ports) {
        const devices = await fetchDevices(port);
        const main = selectMainDevice(devices);
        if (main) {
            await connectToDevice(main, port, {
                reconnectionConfig: {
                    enabled: false,
                    maxAttempts: 0,
                    initialDelayMs: 0,
                    maxDelayMs: 0,
                    backoffMultiplier: 1,
                },
            });

            // connectToDevice resolves with a message string, not the map key.
            // Wait briefly for the async platform detection (findSimulatorByName)
            // to complete, then read the first connected app's platform.
            await new Promise((resolve) => setTimeout(resolve, 2000));

            for (const app of connectedApps.values()) {
                if (app.platform) return app.platform;
            }
        }
    }
    throw new Error("Connected to Metro but could not determine platform");
}

/**
 * Disconnect all apps and clean up state.
 */
export async function disconnectAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [key, app] of connectedApps.entries()) {
        closePromises.push(
            new Promise<void>((resolve) => {
                if (app.ws.readyState === app.ws.CLOSED) {
                    resolve();
                } else {
                    app.ws.on("close", () => resolve());
                    try { app.ws.close(); } catch { resolve(); }
                }
            })
        );
        connectedApps.delete(key);
    }
    await Promise.all(closePromises);
    pendingExecutions.clear();
    cancelAllReconnectionTimers();
    clearAllConnectionState();
}

/**
 * Read the test app's global state to verify a tap was registered.
 * Returns { tapCount, lastTapped } or null if not available.
 */
export async function readTestState(): Promise<{ tapCount: number; lastTapped: string } | null> {
    const result = await executeInApp(
        "JSON.stringify({ tapCount: global.__TEST_STATE__?.tapCount ?? -1, lastTapped: global.__TEST_STATE__?.lastTapped ?? 'unknown' })"
    );
    if (!result.success || !result.result) return null;
    try {
        return JSON.parse(result.result);
    } catch {
        return null;
    }
}

/**
 * Reset the test app's tap counter and last-tapped state.
 */
export async function resetTestState(): Promise<void> {
    await executeInApp("global.__TEST_STATE__?.reset?.()");
}

/**
 * Assert that a tap result succeeded and the test app registered the tap on the expected element.
 */
export async function assertTapWorked(result: TapResult, expectedElement: string): Promise<void> {
    if (!result.success) {
        throw new Error(`Tap failed: ${result.error ?? result.suggestion ?? "unknown reason"}`);
    }
    const state = await readTestState();
    if (!state) {
        throw new Error("Could not read test app state via execute_in_app");
    }
    if (state.lastTapped !== expectedElement) {
        throw new Error(`Expected lastTapped="${expectedElement}" but got "${state.lastTapped}"`);
    }
}

/**
 * Wait for a short duration (ms) to let UI settle.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
