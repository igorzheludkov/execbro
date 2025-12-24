import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

// simctl command timeout in milliseconds
const SIMCTL_TIMEOUT = 30000;

// iOS Simulator info
export interface iOSSimulator {
    udid: string;
    name: string;
    state: "Booted" | "Shutdown" | "Creating" | string;
    runtime: string;
    deviceType?: string;
    isAvailable?: boolean;
}

// Result of iOS operations
export interface iOSResult {
    success: boolean;
    result?: string;
    error?: string;
    data?: Buffer;
}

/**
 * Check if simctl is available
 */
export async function isSimctlAvailable(): Promise<boolean> {
    try {
        await execAsync("xcrun simctl help", { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * List iOS simulators
 */
export async function listIOSSimulators(onlyBooted: boolean = false): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        const { stdout } = await execAsync("xcrun simctl list devices -j", {
            timeout: SIMCTL_TIMEOUT
        });

        const data = JSON.parse(stdout);
        const simulators: iOSSimulator[] = [];

        // Parse devices from each runtime
        for (const [runtime, devices] of Object.entries(data.devices)) {
            if (!Array.isArray(devices)) continue;

            for (const device of devices as Array<{
                udid: string;
                name: string;
                state: string;
                isAvailable?: boolean;
                deviceTypeIdentifier?: string;
            }>) {
                if (!device.isAvailable) continue;
                if (onlyBooted && device.state !== "Booted") continue;

                // Extract iOS version from runtime string
                const runtimeMatch = runtime.match(/iOS[- ](\d+[.-]\d+)/i);
                const runtimeVersion = runtimeMatch ? `iOS ${runtimeMatch[1].replace("-", ".")}` : runtime;

                simulators.push({
                    udid: device.udid,
                    name: device.name,
                    state: device.state,
                    runtime: runtimeVersion,
                    deviceType: device.deviceTypeIdentifier,
                    isAvailable: device.isAvailable
                });
            }
        }

        if (simulators.length === 0) {
            return {
                success: true,
                result: onlyBooted
                    ? "No booted iOS simulators. Start a simulator first."
                    : "No available iOS simulators found."
            };
        }

        // Sort: Booted first, then by name
        simulators.sort((a, b) => {
            if (a.state === "Booted" && b.state !== "Booted") return -1;
            if (a.state !== "Booted" && b.state === "Booted") return 1;
            return a.name.localeCompare(b.name);
        });

        const formatted = simulators
            .map((s) => {
                const status = s.state === "Booted" ? "🟢 Booted" : "⚪ Shutdown";
                return `${s.name} (${s.runtime}) - ${status}\n  UDID: ${s.udid}`;
            })
            .join("\n\n");

        return {
            success: true,
            result: `iOS Simulators:\n\n${formatted}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to list simulators: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get the booted simulator UDID
 */
export async function getBootedSimulatorUdid(): Promise<string | null> {
    try {
        const { stdout } = await execAsync("xcrun simctl list devices booted -j", {
            timeout: SIMCTL_TIMEOUT
        });

        const data = JSON.parse(stdout);

        for (const devices of Object.values(data.devices)) {
            if (!Array.isArray(devices)) continue;

            for (const device of devices as Array<{ udid: string; state: string }>) {
                if (device.state === "Booted") {
                    return device.udid;
                }
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Build device selector for simctl command
 */
function buildDeviceArg(udid?: string): string {
    return udid || "booted";
}

/**
 * Take a screenshot from an iOS simulator
 */
export async function iosScreenshot(outputPath?: string, udid?: string): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        const deviceArg = buildDeviceArg(udid);

        // Check if a simulator is booted
        if (!udid) {
            const bootedUdid = await getBootedSimulatorUdid();
            if (!bootedUdid) {
                return {
                    success: false,
                    error: "No iOS simulator is currently running. Start a simulator first."
                };
            }
        }

        // Generate output path if not provided
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const finalOutputPath =
            outputPath || path.join(os.tmpdir(), `ios-screenshot-${timestamp}.png`);

        await execAsync(`xcrun simctl io ${deviceArg} screenshot "${finalOutputPath}"`, {
            timeout: SIMCTL_TIMEOUT
        });

        // Read the screenshot file
        const imageData = await readFile(finalOutputPath);

        return {
            success: true,
            result: finalOutputPath,
            data: imageData
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to capture screenshot: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Install an app on an iOS simulator
 */
export async function iosInstallApp(appPath: string, udid?: string): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        // Verify app exists
        if (!existsSync(appPath)) {
            return {
                success: false,
                error: `App bundle not found: ${appPath}`
            };
        }

        const deviceArg = buildDeviceArg(udid);

        // Check if a simulator is booted
        if (!udid) {
            const bootedUdid = await getBootedSimulatorUdid();
            if (!bootedUdid) {
                return {
                    success: false,
                    error: "No iOS simulator is currently running. Start a simulator first."
                };
            }
        }

        await execAsync(`xcrun simctl install ${deviceArg} "${appPath}"`, {
            timeout: 120000 // 2 minute timeout for install
        });

        return {
            success: true,
            result: `Successfully installed ${path.basename(appPath)}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to install app: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Launch an app on an iOS simulator
 */
export async function iosLaunchApp(bundleId: string, udid?: string): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        const deviceArg = buildDeviceArg(udid);

        // Check if a simulator is booted
        if (!udid) {
            const bootedUdid = await getBootedSimulatorUdid();
            if (!bootedUdid) {
                return {
                    success: false,
                    error: "No iOS simulator is currently running. Start a simulator first."
                };
            }
        }

        await execAsync(`xcrun simctl launch ${deviceArg} ${bundleId}`, {
            timeout: SIMCTL_TIMEOUT
        });

        return {
            success: true,
            result: `Launched ${bundleId}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to launch app: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Open a URL in the iOS simulator
 */
export async function iosOpenUrl(url: string, udid?: string): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        const deviceArg = buildDeviceArg(udid);

        // Check if a simulator is booted
        if (!udid) {
            const bootedUdid = await getBootedSimulatorUdid();
            if (!bootedUdid) {
                return {
                    success: false,
                    error: "No iOS simulator is currently running. Start a simulator first."
                };
            }
        }

        await execAsync(`xcrun simctl openurl ${deviceArg} "${url}"`, {
            timeout: SIMCTL_TIMEOUT
        });

        return {
            success: true,
            result: `Opened URL: ${url}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to open URL: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Terminate an app on an iOS simulator
 */
export async function iosTerminateApp(bundleId: string, udid?: string): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        const deviceArg = buildDeviceArg(udid);

        // Check if a simulator is booted
        if (!udid) {
            const bootedUdid = await getBootedSimulatorUdid();
            if (!bootedUdid) {
                return {
                    success: false,
                    error: "No iOS simulator is currently running. Start a simulator first."
                };
            }
        }

        await execAsync(`xcrun simctl terminate ${deviceArg} ${bundleId}`, {
            timeout: SIMCTL_TIMEOUT
        });

        return {
            success: true,
            result: `Terminated ${bundleId}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to terminate app: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Boot an iOS simulator
 */
export async function iosBootSimulator(udid: string): Promise<iOSResult> {
    try {
        const simctlAvailable = await isSimctlAvailable();
        if (!simctlAvailable) {
            return {
                success: false,
                error: "Xcode command line tools not available. Install Xcode from the App Store."
            };
        }

        await execAsync(`xcrun simctl boot ${udid}`, {
            timeout: 60000 // 1 minute timeout for boot
        });

        // Open Simulator app
        await execAsync("open -a Simulator", { timeout: 10000 }).catch(() => {
            // Ignore if Simulator app doesn't open
        });

        return {
            success: true,
            result: `Simulator ${udid} is now booting`
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Already booted is not an error
        if (errorMessage.includes("Unable to boot device in current state: Booted")) {
            return {
                success: true,
                result: "Simulator is already booted"
            };
        }

        return {
            success: false,
            error: `Failed to boot simulator: ${errorMessage}`
        };
    }
}
