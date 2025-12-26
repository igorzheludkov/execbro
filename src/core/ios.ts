import { exec, execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// simctl command timeout in milliseconds
const SIMCTL_TIMEOUT = 30000;

// IDB command timeout in milliseconds
const IDB_TIMEOUT = 30000;

// Valid button types for IDB ui button command
export const IOS_BUTTON_TYPES = ["HOME", "LOCK", "SIDE_BUTTON", "SIRI", "APPLE_PAY"] as const;
export type iOSButtonType = (typeof IOS_BUTTON_TYPES)[number];

// Track connected IDB simulators to avoid redundant connect calls
const connectedIdbSimulators = new Set<string>();

/**
 * Get the IDB executable path
 * Supports IDB_PATH environment variable for custom installations
 */
function getIdbPath(): string {
    return process.env.IDB_PATH || "idb";
}

/**
 * Run IDB command with execFile (no shell) for proper argument handling
 * This matches the original ios-simulator-mcp implementation
 */
async function runIdb(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    const idbPath = getIdbPath();
    const { stdout, stderr } = await execFileAsync(idbPath, args, {
        timeout: IDB_TIMEOUT
    });
    return {
        stdout: stdout.trim(),
        stderr: stderr.trim()
    };
}

/**
 * Check if IDB is available
 */
export async function isIdbAvailable(): Promise<boolean> {
    try {
        await runIdb("--help");
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensure IDB is connected to the specified simulator
 * IDB requires `idb connect <UDID>` before any UI commands work
 */
async function ensureIdbConnected(udid: string): Promise<{ success: boolean; error?: string }> {
    // Skip if already connected in this session
    if (connectedIdbSimulators.has(udid)) {
        return { success: true };
    }

    try {
        await runIdb("connect", udid);
        connectedIdbSimulators.add(udid);
        return { success: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // "Already connected" is not an error
        if (errorMessage.includes("already connected") || errorMessage.includes("Connected")) {
            connectedIdbSimulators.add(udid);
            return { success: true };
        }
        return {
            success: false,
            error: `Failed to connect IDB to simulator: ${errorMessage}`
        };
    }
}

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
    // For screenshots: scale factor to convert image coords to device coords
    scaleFactor?: number;
    originalWidth?: number;
    originalHeight?: number;
}

// Accessibility element from IDB describe commands
export interface iOSAccessibilityElement {
    AXLabel?: string;
    AXValue?: string;
    AXFrame?: string; // String format: "{{x, y}, {width, height}}"
    frame?: { x: number; y: number; width: number; height: number }; // Parsed object format
    AXUniqueId?: string;
    type?: string;
    children?: iOSAccessibilityElement[];
    [key: string]: unknown; // Allow additional accessibility properties
}

// Result for describe commands that include elements
export interface iOSDescribeResult extends iOSResult {
    elements?: iOSAccessibilityElement[];
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

        // Resize image if needed (API limit: 2000px max for multi-image requests)
        // Return scale factor so AI can convert image coords to device coords
        const MAX_DIMENSION = 2000;
        const image = sharp(finalOutputPath);
        const metadata = await image.metadata();
        const originalWidth = metadata.width || 0;
        const originalHeight = metadata.height || 0;

        let imageData: Buffer;
        let scaleFactor = 1;

        if (originalWidth > MAX_DIMENSION || originalHeight > MAX_DIMENSION) {
            // Calculate scale to fit within MAX_DIMENSION
            scaleFactor = Math.max(originalWidth, originalHeight) / MAX_DIMENSION;

            imageData = await image
                .resize(MAX_DIMENSION, MAX_DIMENSION, {
                    fit: "inside",
                    withoutEnlargement: true
                })
                .png({ compressionLevel: 9 })
                .toBuffer();
        } else {
            imageData = await image
                .png({ compressionLevel: 9 })
                .toBuffer();
        }

        return {
            success: true,
            result: finalOutputPath,
            data: imageData,
            scaleFactor,
            originalWidth,
            originalHeight
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

// ============================================================================
// IDB-Based UI Interaction Tools
// These tools require Facebook IDB (iOS Development Bridge) to be installed
// Install with: brew install idb-companion
// ============================================================================

/**
 * Tap at coordinates on an iOS simulator using IDB
 */
export async function iosTap(
    x: number,
    y: number,
    options?: { duration?: number; udid?: string }
): Promise<iOSResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        // Get simulator UDID (use provided or find booted one)
        const targetUdid = options?.udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        const xRounded = Math.round(x);
        const yRounded = Math.round(y);

        // Build args array for execFile (no shell)
        const args: string[] = ["ui", "tap", "--udid", targetUdid];
        if (options?.duration !== undefined) {
            args.push("--duration", String(options.duration));
        }
        args.push("--json", "--", String(xRounded), String(yRounded));

        const { stderr } = await runIdb(...args);
        if (stderr) throw new Error(stderr);

        return {
            success: true,
            result: `Tapped at (${xRounded}, ${yRounded})`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to tap: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Swipe gesture on an iOS simulator using IDB
 */
export async function iosSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: { duration?: number; delta?: number; udid?: string }
): Promise<iOSResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        const targetUdid = options?.udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        const x1 = Math.round(startX);
        const y1 = Math.round(startY);
        const x2 = Math.round(endX);
        const y2 = Math.round(endY);

        // Build args array for execFile (no shell)
        const args: string[] = ["ui", "swipe", "--udid", targetUdid];
        if (options?.duration !== undefined) {
            args.push("--duration", String(options.duration));
        }
        if (options?.delta !== undefined) {
            args.push("--delta", String(options.delta));
        }
        args.push("--json", "--", String(x1), String(y1), String(x2), String(y2));

        const { stderr } = await runIdb(...args);
        if (stderr) throw new Error(stderr);

        return {
            success: true,
            result: `Swiped from (${x1}, ${y1}) to (${x2}, ${y2})`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to swipe: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Input text into the active field on an iOS simulator using IDB
 */
export async function iosInputText(text: string, udid?: string): Promise<iOSResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        const targetUdid = udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        // Use execFile with args array (no shell escaping needed)
        const { stderr } = await runIdb("ui", "text", "--udid", targetUdid, text);
        if (stderr) throw new Error(stderr);

        return {
            success: true,
            result: `Typed text: "${text}"`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to input text: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Press a hardware button on an iOS simulator using IDB
 */
export async function iosButton(
    button: iOSButtonType,
    options?: { duration?: number; udid?: string }
): Promise<iOSResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        // Validate button type
        if (!IOS_BUTTON_TYPES.includes(button)) {
            return {
                success: false,
                error: `Invalid button type: ${button}. Valid options: ${IOS_BUTTON_TYPES.join(", ")}`
            };
        }

        const targetUdid = options?.udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        // Build args array for execFile (no shell)
        const args: string[] = ["ui", "button", "--udid", targetUdid];
        if (options?.duration !== undefined) {
            args.push("--duration", String(options.duration));
        }
        args.push(button);

        const { stderr } = await runIdb(...args);
        if (stderr) throw new Error(stderr);

        return {
            success: true,
            result: `Pressed ${button} button`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to press button: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Send a key event to an iOS simulator using IDB
 */
export async function iosKeyEvent(
    keycode: number,
    options?: { duration?: number; udid?: string }
): Promise<iOSResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        const targetUdid = options?.udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        // Build args array for execFile (no shell)
        const args: string[] = ["ui", "key", "--udid", targetUdid];
        if (options?.duration !== undefined) {
            args.push("--duration", String(options.duration));
        }
        args.push(String(keycode));

        const { stderr } = await runIdb(...args);
        if (stderr) throw new Error(stderr);

        return {
            success: true,
            result: `Sent key event: ${keycode}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to send key event: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Send a sequence of key events to an iOS simulator using IDB
 */
export async function iosKeySequence(keycodes: number[], udid?: string): Promise<iOSResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        if (!keycodes || keycodes.length === 0) {
            return {
                success: false,
                error: "At least one keycode is required"
            };
        }

        const targetUdid = udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        // Build args array for execFile (no shell)
        const args: string[] = ["ui", "key-sequence", "--udid", targetUdid, ...keycodes.map(String)];

        const { stderr } = await runIdb(...args);
        if (stderr) throw new Error(stderr);

        return {
            success: true,
            result: `Sent key sequence: ${keycodes.join(", ")}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to send key sequence: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Format accessibility tree for human-readable output
 */
function formatAccessibilityTree(elements: iOSAccessibilityElement[], depth: number = 0): string {
    const lines: string[] = [];
    const indent = "  ".repeat(depth);

    for (const element of elements) {
        const parts: string[] = [];

        if (element.type) parts.push(`[${element.type}]`);
        if (element.AXLabel) parts.push(`"${element.AXLabel}"`);
        if (element.AXValue) parts.push(`value="${element.AXValue}"`);
        if (element.frame) {
            const f = element.frame;
            const centerX = Math.round(f.x + f.width / 2);
            const centerY = Math.round(f.y + f.height / 2);
            parts.push(`frame=(${f.x}, ${f.y}, ${f.width}x${f.height}) tap=(${centerX}, ${centerY})`);
        }

        if (parts.length > 0) {
            lines.push(`${indent}${parts.join(" ")}`);
        }

        if (element.children && element.children.length > 0) {
            lines.push(formatAccessibilityTree(element.children, depth + 1));
        }
    }

    return lines.join("\n");
}

/**
 * Get accessibility info for the entire screen using IDB
 */
export async function iosDescribeAll(udid?: string): Promise<iOSDescribeResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        const targetUdid = udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        // Use execFile with args array (no shell)
        const { stdout, stderr } = await runIdb("ui", "describe-all", "--udid", targetUdid, "--json", "--nested");
        if (stderr) throw new Error(stderr);

        // Parse JSON response
        const elements = JSON.parse(stdout) as iOSAccessibilityElement[];

        // Format for human-readable output
        const formatted = formatAccessibilityTree(elements);

        return {
            success: true,
            result: formatted || "No accessibility elements found",
            elements
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to describe screen: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get accessibility info at a specific point using IDB
 */
export async function iosDescribePoint(x: number, y: number, udid?: string): Promise<iOSDescribeResult> {
    try {
        const idbAvailable = await isIdbAvailable();
        if (!idbAvailable) {
            return {
                success: false,
                error: "IDB is not installed. Install with: brew install idb-companion"
            };
        }

        const targetUdid = udid || (await getBootedSimulatorUdid());
        if (!targetUdid) {
            return {
                success: false,
                error: "No iOS simulator is currently running. Start a simulator first."
            };
        }

        // Ensure IDB is connected to the simulator
        const connectResult = await ensureIdbConnected(targetUdid);
        if (!connectResult.success) {
            return { success: false, error: connectResult.error };
        }

        const xRounded = Math.round(x);
        const yRounded = Math.round(y);

        // Use execFile with args array (no shell)
        const { stdout, stderr } = await runIdb("ui", "describe-point", "--udid", targetUdid, "--json", "--", String(xRounded), String(yRounded));
        if (stderr) throw new Error(stderr);

        // Parse JSON response - may be single element or array
        let element: iOSAccessibilityElement;
        try {
            const parsed = JSON.parse(stdout);
            element = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch {
            return {
                success: true,
                result: `No accessibility element found at (${xRounded}, ${yRounded})`,
                elements: []
            };
        }

        // Format for human-readable output
        const parts: string[] = [];
        if (element.type) parts.push(`Type: ${element.type}`);
        if (element.AXLabel) parts.push(`Label: "${element.AXLabel}"`);
        if (element.AXValue) parts.push(`Value: "${element.AXValue}"`);
        if (element.frame) {
            const f = element.frame;
            const centerX = Math.round(f.x + f.width / 2);
            const centerY = Math.round(f.y + f.height / 2);
            parts.push(`Frame: (${f.x}, ${f.y}) ${f.width}x${f.height}`);
            parts.push(`Tap: (${centerX}, ${centerY})`);
        }

        return {
            success: true,
            result: parts.length > 0
                ? `Element at (${xRounded}, ${yRounded}):\n${parts.join("\n")}`
                : `No accessibility element found at (${xRounded}, ${yRounded})`,
            elements: element ? [element] : []
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to describe point: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Helper to flatten nested accessibility elements
 */
function flattenElements(elements: iOSAccessibilityElement[]): iOSAccessibilityElement[] {
    const result: iOSAccessibilityElement[] = [];
    for (const el of elements) {
        result.push(el);
        if (el.children && el.children.length > 0) {
            result.push(...flattenElements(el.children));
        }
    }
    return result;
}

/**
 * Tap an element by its accessibility label using IDB
 * This simplifies the workflow: no need to manually find coordinates
 */
export async function iosTapElement(
    options: {
        label?: string;
        labelContains?: string;
        index?: number;
        duration?: number;
        udid?: string;
    }
): Promise<iOSResult> {
    try {
        const { label, labelContains, index = 0, duration, udid } = options;

        if (!label && !labelContains) {
            return {
                success: false,
                error: "Either 'label' (exact match) or 'labelContains' (partial match) is required"
            };
        }

        // Get all accessibility elements
        const describeResult = await iosDescribeAll(udid);
        if (!describeResult.success || !describeResult.elements) {
            return {
                success: false,
                error: describeResult.error || "Failed to get accessibility elements"
            };
        }

        // Flatten the tree and find matching elements
        const allElements = flattenElements(describeResult.elements);
        const matches = allElements.filter(el => {
            if (!el.AXLabel) return false;
            if (label) return el.AXLabel === label;
            if (labelContains) return el.AXLabel.toLowerCase().includes(labelContains.toLowerCase());
            return false;
        });

        if (matches.length === 0) {
            const searchTerm = label ? `label="${label}"` : `labelContains="${labelContains}"`;
            return {
                success: false,
                error: `No element found with ${searchTerm}`
            };
        }

        // Select element by index (default 0 = first match)
        if (index >= matches.length) {
            return {
                success: false,
                error: `Index ${index} out of range. Found ${matches.length} matching element(s).`
            };
        }

        const element = matches[index];

        // Check if element has frame coordinates
        if (!element.frame) {
            return {
                success: false,
                error: `Element "${element.AXLabel}" has no frame coordinates`
            };
        }

        // Calculate center
        const centerX = Math.round(element.frame.x + element.frame.width / 2);
        const centerY = Math.round(element.frame.y + element.frame.height / 2);

        // Tap at center
        const tapResult = await iosTap(centerX, centerY, { duration, udid });

        if (tapResult.success) {
            return {
                success: true,
                result: `Tapped "${element.AXLabel}" at (${centerX}, ${centerY})`
            };
        }

        return tapResult;
    } catch (error) {
        return {
            success: false,
            error: `Failed to tap element: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
