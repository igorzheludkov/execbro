import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import {
    listAndroidDevices,
    androidLaunchApp,
    androidListPackages,
    listIOSSimulators,
    iosLaunchApp,
    iosTerminateApp,
    iosBootSimulator,
    iosOpenUrl,
} from "../core/index.js";
import { platformUniqueBanner } from "../core/toolHelpers.js";
import { listAllDevices } from "../core/deviceDiscovery.js";
import { getConnectedApps } from "../core/connection.js";
import { resolveAndroidDeviceId, resolveIosUdid, ANDROID_ARG_DESC, IOS_ARG_DESC } from "./_deviceArg.js";

export function registerDeviceTools(server: McpServer): void {
    // ============================================================================

    // Tool: List all devices (cross-platform, works without React Native)
    registerToolWithTelemetry(
        server,
        "list_devices",
        {
            description:
                "List every iOS simulator, Android emulator, and connected physical device on the host machine, in one structured response.\n" +
                "PURPOSE: Single discovery entry point. Returns booted+shutdown iOS sims (from simctl), running+stopped Android emulators (from `emulator -list-avds` cross-referenced with `adb devices`), and attached physical devices. Each row is enriched with `rnConnected` when an RN app from get_apps matches the same identifier.\n" +
                "WHEN TO USE: Before tap/swipe to pick a device, when a tool reports an ambiguous-device error, or to check whether a simulator is booted before targeting it.\n" +
                "WORKS WITHOUT RN: No Metro connection required. Safe to call before scan_metro.\n" +
                "WORKFLOW: list_devices -> tap({ device: '<udid-or-serial-or-name>', ... })\n" +
                "SEE ALSO: get_apps for RN-specific connection details (RN version, JS engine, network capture mode).",
            inputSchema: {
                refresh: z
                    .coerce
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Force re-query of simctl/adb/emulator instead of returning cached results (5s TTL).")
            }
        },
        async ({ refresh }) => {
            const inventory = await listAllDevices({ refresh });

            // Best-effort RN enrichment. If the registry is empty, this loop
            // is a no-op and the OS-level inventory is returned untouched —
            // preserves the "works without React Native" guarantee.
            const apps = getConnectedApps();
            if (apps.length > 0) {
                const byUdid = new Map<string, { deviceName: string; port: number }>();
                const bySerial = new Map<string, { deviceName: string; port: number }>();
                for (const { app } of apps) {
                    const entry = { deviceName: app.deviceInfo.deviceName, port: app.port };
                    if (app.simulatorUdid) byUdid.set(app.simulatorUdid.toLowerCase(), entry);
                    if (app.adbSerial) bySerial.set(app.adbSerial, entry);
                }
                for (const sim of inventory.ios.simulators) {
                    const match = byUdid.get(sim.udid.toLowerCase());
                    if (match) sim.rnConnected = match;
                }
                for (const emu of inventory.android.emulators) {
                    if (emu.serial) {
                        const match = bySerial.get(emu.serial);
                        if (match) emu.rnConnected = match;
                    }
                }
                for (const phys of inventory.android.physical) {
                    const match = bySerial.get(phys.serial);
                    if (match) phys.rnConnected = match;
                }
            }

            const lines: string[] = [];
            lines.push(`Devices: ${inventory.summary.booted} running, ${inventory.summary.total} total`);

            if (inventory.ios.available) {
                lines.push("\niOS simulators:");
                if (inventory.ios.simulators.length === 0) {
                    lines.push("  (none)");
                } else {
                    for (const s of inventory.ios.simulators) {
                        const badge = s.state === "booted" ? "🟢 booted" : "⚪ shutdown";
                        const rn = s.rnConnected ? `  [RN connected on port ${s.rnConnected.port}]` : "";
                        lines.push(`  ${s.name} (${s.runtime}) — ${badge} — UDID: ${s.udid}${rn}`);
                    }
                }
            } else {
                lines.push(`\niOS: unavailable (${inventory.ios.error ?? "unknown"})`);
            }

            if (inventory.android.available) {
                lines.push("\nAndroid emulators:");
                if (inventory.android.emulators.length === 0) {
                    lines.push("  (none)");
                } else {
                    for (const e of inventory.android.emulators) {
                        const badge = e.state === "running" ? `🟢 running (${e.serial})` : "⚪ stopped";
                        const rn = e.rnConnected ? `  [RN connected on port ${e.rnConnected.port}]` : "";
                        lines.push(`  ${e.name} — ${badge}${rn}`);
                    }
                }
                if (inventory.android.physical.length > 0) {
                    lines.push("\nAndroid physical:");
                    for (const p of inventory.android.physical) {
                        const rn = p.rnConnected ? `  [RN connected on port ${p.rnConnected.port}]` : "";
                        lines.push(`  ${p.model} (${p.serial}) — ${p.state}${rn}`);
                    }
                }
            } else {
                lines.push(`\nAndroid: unavailable (${inventory.android.error ?? "unknown"})`);
            }

            return {
                content: [
                    { type: "text", text: lines.join("\n") },
                    { type: "text", text: JSON.stringify(inventory, null, 2) }
                ]
            };
        }
    );

    // Tool: Android launch app
    registerToolWithTelemetry(
        server,
        "android_launch_app",
        {
            description: "Launch an app on an Android device/emulator by package name" +
                platformUniqueBanner("launching an Android app by package name") +
                "\nPURPOSE: Start an installed Android app by its package (and optional activity) so the next tool calls hit a running process." +
                "\nWHEN TO USE: After a force-stop or install, or when the app isn't foregrounded before interaction.",
            inputSchema: {
                packageName: z.string().describe("Package name of the app (e.g., com.example.myapp)"),
                activityName: z
                    .string()
                    .optional()
                    .describe(
                        "Optional activity name to launch (e.g., .MainActivity). If not provided, launches the main activity."
                    ),
                deviceId: z
                    .string()
                    .optional()
                    .describe(ANDROID_ARG_DESC)
            }
        },
        async ({ packageName, activityName, deviceId }) => {
            const r = await resolveAndroidDeviceId(deviceId);
            if (!r.ok) return r.response;
            const result = await androidLaunchApp(packageName, activityName, r.serial);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: Android list packages
    registerToolWithTelemetry(
        server,
        "android_list_packages",
        {
            description: "List installed packages on an Android device/emulator" +
                platformUniqueBanner("listing installed Android packages") +
                "\nPURPOSE: Enumerate package names visible to adb so you can confirm installation or pick the right target for android_launch_app." +
                "\nWHEN TO USE: Before android_launch_app when you don't know the exact package name, or to verify an install succeeded.",
            inputSchema: {
                deviceId: z
                    .string()
                    .optional()
                    .describe(ANDROID_ARG_DESC),
                filter: z.string().optional().describe("Optional filter to search packages by name (case-insensitive)")
            }
        },
        async ({ deviceId, filter }) => {
            const r = await resolveAndroidDeviceId(deviceId);
            if (!r.ok) return r.response;
            const result = await androidListPackages(r.serial, filter);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    // Tool: iOS launch app
    registerToolWithTelemetry(
        server,
        "ios_launch_app",
        {
            description: "Launch an app on an iOS simulator by bundle ID" +
                platformUniqueBanner("launching an iOS app by bundle ID") +
                "\nPURPOSE: Start an installed iOS app by its bundle ID so the next tool calls hit a running process." +
                "\nWHEN TO USE: After ios_terminate_app or an install, or when the app isn't foregrounded before interaction.",
            inputSchema: {
                bundleId: z.string().describe("Bundle ID of the app (e.g., com.example.myapp)"),
                udid: z.string().optional().describe(IOS_ARG_DESC)
            }
        },
        async ({ bundleId, udid }) => {
            const r = await resolveIosUdid(udid);
            if (!r.ok) return r.response;
            const result = await iosLaunchApp(bundleId, r.udid);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: iOS open URL
    registerToolWithTelemetry(
        server,
        "ios_open_url",
        {
            description: "Open a URL in the iOS simulator (opens in default handler or Safari).\n" +
                "PURPOSE: Drive an iOS simulator into a deep link or universal link entry point so you can exercise routing from an external entry.\n" +
                "WHEN TO USE: Testing deep-link handlers, universal link routing, OAuth/SSO callback URLs, or any flow that enters the app via a URL.\n" +
                "WORKFLOW: ios_boot_simulator -> ios_launch_app (or have the app running) -> ios_open_url -> ios_screenshot / get_screen_layout to verify the target screen rendered.\n" +
                "GOOD: ios_open_url(url=\"myapp://product/42\") to land directly on a product screen.\n" +
                "BAD: ios_open_url(url=\"...\") used as a substitute for in-app navigation when the user would normally tap — prefer `tap` for normal interaction flows.\n" +
                platformUniqueBanner("testing iOS deep links or universal links"),
            inputSchema: {
                url: z.string().describe("URL to open (e.g., https://example.com or myapp://path)"),
                udid: z.string().optional().describe(IOS_ARG_DESC)
            }
        },
        async ({ url, udid }) => {
            const r = await resolveIosUdid(udid);
            if (!r.ok) return r.response;
            const result = await iosOpenUrl(url, r.udid);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: iOS terminate app
    registerToolWithTelemetry(
        server,
        "ios_terminate_app",
        {
            description: "Terminate a running app on an iOS simulator" +
                platformUniqueBanner("force-terminating an iOS app") +
                "\nPURPOSE: Force-kill an iOS app process so the next launch starts from a cold state." +
                "\nWHEN TO USE: To reset app state fully (beyond what reload_app does), or before reinstalling a new build.",
            inputSchema: {
                bundleId: z.string().describe("Bundle ID of the app to terminate"),
                udid: z.string().optional().describe(IOS_ARG_DESC)
            }
        },
        async ({ bundleId, udid }) => {
            const r = await resolveIosUdid(udid);
            if (!r.ok) return r.response;
            const result = await iosTerminateApp(bundleId, r.udid);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: iOS boot simulator
    registerToolWithTelemetry(
        server,
        "ios_boot_simulator",
        {
            description: "Boot an iOS simulator by UDID.\n" +
                "PURPOSE: Bring a specific simulator online so you can install/launch an app in it.\n" +
                "WHEN TO USE: At session start when no simulator is running, or after switching between device models.\n" +
                platformUniqueBanner("booting an iOS simulator") +
                " Use list_devices to find available simulators.",
            inputSchema: {
                udid: z.string().describe("UDID of the simulator to boot (from list_devices)")
            }
        },
        async ({ udid }) => {
            // The only iOS handler that used to pass its identifier straight to
            // simctl. Resolving it against the real device inventory matches the
            // rest of the surface and turns a typo into a useful error instead
            // of a raw simctl failure. The inventory includes shut-down
            // simulators, which is exactly what this tool targets — hence
            // allowShutdown: without it the resolver answered a shut-down UDID
            // with "not booted, boot it with ios_boot_simulator({...})", telling
            // the boot tool to call itself. That circular error was 10 of this
            // tool's 11 calls in the 7d telemetry (2026-08-22). Typos still
            // error DEVICE_NOT_FOUND.
            const r = await resolveIosUdid(udid, { allowShutdown: true });
            if (!r.ok) return r.response;
            const result = await iosBootSimulator(r.udid ?? udid);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
}
