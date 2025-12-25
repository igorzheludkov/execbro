import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";

const execAsync = promisify(exec);

// ADB command timeout in milliseconds
const ADB_TIMEOUT = 30000;

// Android device info
export interface AndroidDevice {
    id: string;
    status: "device" | "offline" | "unauthorized" | "no permissions" | string;
    product?: string;
    model?: string;
    device?: string;
    transportId?: string;
}

// Result of ADB operations
export interface AdbResult {
    success: boolean;
    result?: string;
    error?: string;
    data?: Buffer;
    // For screenshots: scale factor to convert image coords to device coords
    scaleFactor?: number;
    originalWidth?: number;
    originalHeight?: number;
}

/**
 * Check if ADB is available in PATH
 */
export async function isAdbAvailable(): Promise<boolean> {
    try {
        await execAsync("adb version", { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * List connected Android devices
 */
export async function listAndroidDevices(): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const { stdout } = await execAsync("adb devices -l", { timeout: ADB_TIMEOUT });

        const lines = stdout.trim().split("\n");
        // Skip the "List of devices attached" header
        const deviceLines = lines.slice(1).filter((line) => line.trim().length > 0);

        if (deviceLines.length === 0) {
            return {
                success: true,
                result: "No Android devices connected."
            };
        }

        const devices: AndroidDevice[] = deviceLines.map((line) => {
            const parts = line.trim().split(/\s+/);
            const id = parts[0];
            const status = parts[1] as AndroidDevice["status"];

            const device: AndroidDevice = { id, status };

            // Parse additional info like product:xxx model:xxx device:xxx transport_id:xxx
            for (let i = 2; i < parts.length; i++) {
                const [key, value] = parts[i].split(":");
                if (key === "product") device.product = value;
                else if (key === "model") device.model = value;
                else if (key === "device") device.device = value;
                else if (key === "transport_id") device.transportId = value;
            }

            return device;
        });

        const formatted = devices
            .map((d) => {
                let info = `${d.id} (${d.status})`;
                if (d.model) info += ` - ${d.model.replace(/_/g, " ")}`;
                if (d.product) info += ` [${d.product}]`;
                return info;
            })
            .join("\n");

        return {
            success: true,
            result: `Connected Android devices:\n${formatted}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to list devices: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get the first connected Android device ID
 */
export async function getDefaultAndroidDevice(): Promise<string | null> {
    try {
        const { stdout } = await execAsync("adb devices", { timeout: ADB_TIMEOUT });
        const lines = stdout.trim().split("\n");
        const deviceLines = lines.slice(1).filter((line) => line.trim().length > 0);

        for (const line of deviceLines) {
            const [id, status] = line.trim().split(/\s+/);
            if (status === "device") {
                return id;
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Build device selector for ADB command
 */
function buildDeviceArg(deviceId?: string): string {
    return deviceId ? `-s ${deviceId}` : "";
}

/**
 * Take a screenshot from an Android device
 */
export async function androidScreenshot(
    outputPath?: string,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        // Generate output path if not provided
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const finalOutputPath =
            outputPath || path.join(os.tmpdir(), `android-screenshot-${timestamp}.png`);

        // Capture screenshot on device
        const remotePath = "/sdcard/screenshot-temp.png";
        await execAsync(`adb ${deviceArg} shell screencap -p ${remotePath}`, {
            timeout: ADB_TIMEOUT
        });

        // Pull screenshot to local machine
        await execAsync(`adb ${deviceArg} pull ${remotePath} "${finalOutputPath}"`, {
            timeout: ADB_TIMEOUT
        });

        // Clean up remote file
        await execAsync(`adb ${deviceArg} shell rm ${remotePath}`, {
            timeout: ADB_TIMEOUT
        }).catch(() => {
            // Ignore cleanup errors
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
 * Install an APK on an Android device
 */
export async function androidInstallApp(
    apkPath: string,
    deviceId?: string,
    options?: { replace?: boolean; grantPermissions?: boolean }
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        // Verify APK exists
        if (!existsSync(apkPath)) {
            return {
                success: false,
                error: `APK file not found: ${apkPath}`
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        // Build install flags
        const flags: string[] = [];
        if (options?.replace) flags.push("-r");
        if (options?.grantPermissions) flags.push("-g");
        const flagsStr = flags.length > 0 ? flags.join(" ") + " " : "";

        const { stdout, stderr } = await execAsync(
            `adb ${deviceArg} install ${flagsStr}"${apkPath}"`,
            { timeout: 120000 } // 2 minute timeout for install
        );

        const output = stdout + stderr;

        if (output.includes("Success")) {
            return {
                success: true,
                result: `Successfully installed ${path.basename(apkPath)}`
            };
        } else {
            return {
                success: false,
                error: output.trim() || "Installation failed with unknown error"
            };
        }
    } catch (error) {
        return {
            success: false,
            error: `Failed to install app: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Launch an app on an Android device
 */
export async function androidLaunchApp(
    packageName: string,
    activityName?: string,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        let command: string;

        if (activityName) {
            // Launch specific activity
            command = `adb ${deviceArg} shell am start -n ${packageName}/${activityName}`;
        } else {
            // Launch main/launcher activity
            command = `adb ${deviceArg} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;
        }

        const { stdout, stderr } = await execAsync(command, { timeout: ADB_TIMEOUT });
        const output = stdout + stderr;

        // Check for errors
        if (output.includes("Error") || output.includes("Exception")) {
            return {
                success: false,
                error: output.trim()
            };
        }

        return {
            success: true,
            result: `Launched ${packageName}${activityName ? `/${activityName}` : ""}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to launch app: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get list of installed packages on the device
 */
export async function androidListPackages(
    deviceId?: string,
    filter?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        const { stdout } = await execAsync(`adb ${deviceArg} shell pm list packages`, {
            timeout: ADB_TIMEOUT
        });

        let packages = stdout
            .trim()
            .split("\n")
            .map((line) => line.replace("package:", "").trim())
            .filter((pkg) => pkg.length > 0);

        if (filter) {
            const filterLower = filter.toLowerCase();
            packages = packages.filter((pkg) => pkg.toLowerCase().includes(filterLower));
        }

        if (packages.length === 0) {
            return {
                success: true,
                result: filter ? `No packages found matching "${filter}"` : "No packages found"
            };
        }

        return {
            success: true,
            result: `Installed packages${filter ? ` matching "${filter}"` : ""}:\n${packages.join("\n")}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to list packages: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

// ============================================================================
// UI Input Functions (Phase 2)
// ============================================================================

/**
 * Common key event codes for Android
 */
export const ANDROID_KEY_EVENTS = {
    HOME: 3,
    BACK: 4,
    CALL: 5,
    END_CALL: 6,
    VOLUME_UP: 24,
    VOLUME_DOWN: 25,
    POWER: 26,
    CAMERA: 27,
    CLEAR: 28,
    TAB: 61,
    ENTER: 66,
    DEL: 67,
    MENU: 82,
    SEARCH: 84,
    MEDIA_PLAY_PAUSE: 85,
    MEDIA_STOP: 86,
    MEDIA_NEXT: 87,
    MEDIA_PREVIOUS: 88,
    MOVE_HOME: 122,
    MOVE_END: 123,
    APP_SWITCH: 187,
    ESCAPE: 111
} as const;

/**
 * Tap at coordinates on an Android device
 */
export async function androidTap(
    x: number,
    y: number,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        await execAsync(`adb ${deviceArg} shell input tap ${Math.round(x)} ${Math.round(y)}`, {
            timeout: ADB_TIMEOUT
        });

        return {
            success: true,
            result: `Tapped at (${Math.round(x)}, ${Math.round(y)})`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to tap: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Long press at coordinates on an Android device
 */
export async function androidLongPress(
    x: number,
    y: number,
    durationMs: number = 1000,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        // Long press is implemented as a swipe from the same point to the same point
        const xRounded = Math.round(x);
        const yRounded = Math.round(y);

        await execAsync(
            `adb ${deviceArg} shell input swipe ${xRounded} ${yRounded} ${xRounded} ${yRounded} ${durationMs}`,
            { timeout: ADB_TIMEOUT + durationMs }
        );

        return {
            success: true,
            result: `Long pressed at (${xRounded}, ${yRounded}) for ${durationMs}ms`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to long press: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Swipe on an Android device
 */
export async function androidSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number = 300,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        const x1 = Math.round(startX);
        const y1 = Math.round(startY);
        const x2 = Math.round(endX);
        const y2 = Math.round(endY);

        await execAsync(
            `adb ${deviceArg} shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`,
            { timeout: ADB_TIMEOUT + durationMs }
        );

        return {
            success: true,
            result: `Swiped from (${x1}, ${y1}) to (${x2}, ${y2}) in ${durationMs}ms`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to swipe: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Input text on an Android device
 *
 * ADB input text has limitations with special characters.
 * This function handles escaping properly for URLs, emails, and special strings.
 */
export async function androidInputText(
    text: string,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        // For complex strings with special characters, type character by character
        // using key events for reliability
        const hasComplexChars = /[/:?=&#@%+]/.test(text);

        if (hasComplexChars) {
            // Use character-by-character input for strings with special chars
            // This is slower but more reliable for URLs, emails, etc.
            for (const char of text) {
                let keyCmd: string;

                // Map special characters to their escaped form or use direct input
                switch (char) {
                    case " ":
                        keyCmd = `adb ${deviceArg} shell input text "%s"`;
                        break;
                    case "'":
                        // Single quote needs special handling
                        keyCmd = `adb ${deviceArg} shell input text "\\'"`;
                        break;
                    case '"':
                        keyCmd = `adb ${deviceArg} shell input text '\\"'`;
                        break;
                    case "\\":
                        keyCmd = `adb ${deviceArg} shell input text "\\\\"`;
                        break;
                    case "&":
                        keyCmd = `adb ${deviceArg} shell input text "\\&"`;
                        break;
                    case "|":
                        keyCmd = `adb ${deviceArg} shell input text "\\|"`;
                        break;
                    case ";":
                        keyCmd = `adb ${deviceArg} shell input text "\\;"`;
                        break;
                    case "<":
                        keyCmd = `adb ${deviceArg} shell input text "\\<"`;
                        break;
                    case ">":
                        keyCmd = `adb ${deviceArg} shell input text "\\>"`;
                        break;
                    case "(":
                        keyCmd = `adb ${deviceArg} shell input text "\\("`;
                        break;
                    case ")":
                        keyCmd = `adb ${deviceArg} shell input text "\\)"`;
                        break;
                    case "$":
                        keyCmd = `adb ${deviceArg} shell input text "\\$"`;
                        break;
                    case "`":
                        keyCmd = `adb ${deviceArg} shell input text "\\\`"`;
                        break;
                    default:
                        // For most characters, wrap in single quotes to prevent shell interpretation
                        // Single quotes preserve literal meaning of all characters except single quote itself
                        keyCmd = `adb ${deviceArg} shell input text '${char}'`;
                }

                await execAsync(keyCmd, { timeout: 5000 });
            }

            return {
                success: true,
                result: `Typed: "${text}"`
            };
        }

        // For simple alphanumeric strings, use the faster bulk input
        // Escape basic special characters
        const escapedText = text
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/'/g, "\\'")
            .replace(/`/g, "\\`")
            .replace(/\$/g, "\\$")
            .replace(/ /g, "%s");

        await execAsync(`adb ${deviceArg} shell input text "${escapedText}"`, {
            timeout: ADB_TIMEOUT
        });

        return {
            success: true,
            result: `Typed: "${text}"`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to input text: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Send a key event to an Android device
 */
export async function androidKeyEvent(
    keyCode: number | keyof typeof ANDROID_KEY_EVENTS,
    deviceId?: string
): Promise<AdbResult> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        // Resolve key code from name if needed
        const resolvedKeyCode =
            typeof keyCode === "string" ? ANDROID_KEY_EVENTS[keyCode] : keyCode;

        if (resolvedKeyCode === undefined) {
            return {
                success: false,
                error: `Invalid key code: ${keyCode}`
            };
        }

        await execAsync(`adb ${deviceArg} shell input keyevent ${resolvedKeyCode}`, {
            timeout: ADB_TIMEOUT
        });

        // Get key name for display
        const keyName =
            typeof keyCode === "string"
                ? keyCode
                : Object.entries(ANDROID_KEY_EVENTS).find(([_, v]) => v === keyCode)?.[0] ||
                  `keycode ${keyCode}`;

        return {
            success: true,
            result: `Sent key event: ${keyName}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to send key event: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get device screen size
 */
export async function androidGetScreenSize(deviceId?: string): Promise<{
    success: boolean;
    width?: number;
    height?: number;
    error?: string;
}> {
    try {
        const adbAvailable = await isAdbAvailable();
        if (!adbAvailable) {
            return {
                success: false,
                error: "ADB is not installed or not in PATH. Install Android SDK Platform Tools."
            };
        }

        const deviceArg = buildDeviceArg(deviceId);
        const device = deviceId || (await getDefaultAndroidDevice());

        if (!device) {
            return {
                success: false,
                error: "No Android device connected. Connect a device or start an emulator."
            };
        }

        const { stdout } = await execAsync(`adb ${deviceArg} shell wm size`, {
            timeout: ADB_TIMEOUT
        });

        // Parse output like "Physical size: 1080x1920"
        const match = stdout.match(/(\d+)x(\d+)/);
        if (match) {
            return {
                success: true,
                width: parseInt(match[1], 10),
                height: parseInt(match[2], 10)
            };
        }

        return {
            success: false,
            error: `Could not parse screen size from: ${stdout.trim()}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to get screen size: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
