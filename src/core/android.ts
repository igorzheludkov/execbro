import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";

const execAsync = promisify(exec);

// XML parsing for uiautomator dump
import { XMLParser } from "fast-xml-parser";

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

// ============================================================================
// UI Accessibility Functions (Element Finding)
// ============================================================================

/**
 * UI Element from accessibility tree
 */
export interface AndroidUIElement {
    text: string;
    contentDesc: string;
    resourceId: string;
    className: string;
    bounds: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
    center: { x: number; y: number };
    clickable: boolean;
    enabled: boolean;
    focused: boolean;
    scrollable: boolean;
    selected: boolean;
}

/**
 * Result of element find operations
 */
export interface FindElementResult {
    success: boolean;
    found: boolean;
    element?: AndroidUIElement;
    allMatches?: AndroidUIElement[];
    matchCount?: number;
    error?: string;
}

/**
 * Result of wait for element operations
 */
export interface WaitForElementResult extends FindElementResult {
    elapsedMs?: number;
    timedOut?: boolean;
}

/**
 * Options for finding elements
 */
export interface FindElementOptions {
    text?: string;
    textContains?: string;
    contentDesc?: string;
    contentDescContains?: string;
    resourceId?: string;
    index?: number;
}

/**
 * Parse bounds string like "[0,0][1080,1920]" to AndroidUIElement bounds
 */
function parseBoundsForUIElement(boundsStr: string): AndroidUIElement["bounds"] | null {
    const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!match) return null;

    const left = parseInt(match[1], 10);
    const top = parseInt(match[2], 10);
    const right = parseInt(match[3], 10);
    const bottom = parseInt(match[4], 10);

    return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top
    };
}

/**
 * Parse uiautomator XML dump into element array
 */
function parseUIAutomatorXML(xml: string): AndroidUIElement[] {
    const elements: AndroidUIElement[] = [];

    // Match all node elements with their attributes
    const nodeRegex = /<node\s+([^>]+)\/?>|<node\s+([^>]+)>/g;
    let match;

    while ((match = nodeRegex.exec(xml)) !== null) {
        const attrStr = match[1] || match[2];
        if (!attrStr) continue;

        // Extract attributes
        const getAttr = (name: string): string => {
            const attrMatch = attrStr.match(new RegExp(`${name}="([^"]*)"`));
            return attrMatch ? attrMatch[1] : "";
        };

        const boundsStr = getAttr("bounds");
        const bounds = parseBoundsForUIElement(boundsStr);
        if (!bounds) continue;

        const element: AndroidUIElement = {
            text: getAttr("text"),
            contentDesc: getAttr("content-desc"),
            resourceId: getAttr("resource-id"),
            className: getAttr("class"),
            bounds,
            center: {
                x: Math.round((bounds.left + bounds.right) / 2),
                y: Math.round((bounds.top + bounds.bottom) / 2)
            },
            clickable: getAttr("clickable") === "true",
            enabled: getAttr("enabled") === "true",
            focused: getAttr("focused") === "true",
            scrollable: getAttr("scrollable") === "true",
            selected: getAttr("selected") === "true"
        };

        elements.push(element);
    }

    return elements;
}

/**
 * Match element against find options
 */
function matchesElement(element: AndroidUIElement, options: FindElementOptions): boolean {
    if (options.text !== undefined) {
        if (element.text !== options.text) return false;
    }
    if (options.textContains !== undefined) {
        if (!element.text.toLowerCase().includes(options.textContains.toLowerCase())) return false;
    }
    if (options.contentDesc !== undefined) {
        if (element.contentDesc !== options.contentDesc) return false;
    }
    if (options.contentDescContains !== undefined) {
        if (!element.contentDesc.toLowerCase().includes(options.contentDescContains.toLowerCase())) return false;
    }
    if (options.resourceId !== undefined) {
        // Support both full "com.app:id/button" and short "button" forms
        const shortId = element.resourceId.split("/").pop() || "";
        if (element.resourceId !== options.resourceId && shortId !== options.resourceId) return false;
    }
    return true;
}

/**
 * Get UI accessibility tree from Android device using uiautomator
 */
export async function androidGetUITree(deviceId?: string): Promise<{
    success: boolean;
    elements?: AndroidUIElement[];
    rawXml?: string;
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

        // Dump UI hierarchy to device
        const remotePath = "/sdcard/ui_dump.xml";
        await execAsync(`adb ${deviceArg} shell uiautomator dump ${remotePath}`, {
            timeout: ADB_TIMEOUT
        });

        // Read the XML content
        const { stdout } = await execAsync(`adb ${deviceArg} shell cat ${remotePath}`, {
            timeout: ADB_TIMEOUT
        });

        // Clean up remote file
        await execAsync(`adb ${deviceArg} shell rm ${remotePath}`, {
            timeout: ADB_TIMEOUT
        }).catch(() => {});

        const elements = parseUIAutomatorXML(stdout);

        return {
            success: true,
            elements,
            rawXml: stdout
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to get UI tree: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Find element(s) in the UI tree matching the given criteria
 */
export async function androidFindElement(
    options: FindElementOptions,
    deviceId?: string
): Promise<FindElementResult> {
    try {
        // Validate that at least one search criteria is provided
        if (!options.text && !options.textContains && !options.contentDesc &&
            !options.contentDescContains && !options.resourceId) {
            return {
                success: false,
                found: false,
                error: "At least one search criteria (text, textContains, contentDesc, contentDescContains, or resourceId) must be provided"
            };
        }

        const treeResult = await androidGetUITree(deviceId);
        if (!treeResult.success || !treeResult.elements) {
            return {
                success: false,
                found: false,
                error: treeResult.error
            };
        }

        // Find matching elements
        const matches = treeResult.elements.filter(el => matchesElement(el, options));

        if (matches.length === 0) {
            return {
                success: true,
                found: false,
                matchCount: 0
            };
        }

        // Select the element at the specified index (default 0)
        const index = options.index ?? 0;
        const selectedElement = matches[index];

        if (!selectedElement) {
            return {
                success: true,
                found: false,
                matchCount: matches.length,
                error: `Index ${index} out of bounds. Found ${matches.length} matching element(s).`
            };
        }

        return {
            success: true,
            found: true,
            element: selectedElement,
            allMatches: matches,
            matchCount: matches.length
        };
    } catch (error) {
        return {
            success: false,
            found: false,
            error: `Failed to find element: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Wait for element to appear on screen with polling
 */
export async function androidWaitForElement(
    options: FindElementOptions & {
        timeoutMs?: number;
        pollIntervalMs?: number;
    },
    deviceId?: string
): Promise<WaitForElementResult> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const startTime = Date.now();

    // Validate that at least one search criteria is provided
    if (!options.text && !options.textContains && !options.contentDesc &&
        !options.contentDescContains && !options.resourceId) {
        return {
            success: false,
            found: false,
            timedOut: false,
            error: "At least one search criteria (text, textContains, contentDesc, contentDescContains, or resourceId) must be provided"
        };
    }

    while (Date.now() - startTime < timeoutMs) {
        const result = await androidFindElement(options, deviceId);

        if (result.found && result.element) {
            return {
                ...result,
                elapsedMs: Date.now() - startTime,
                timedOut: false
            };
        }

        // If there was an error (not just "not found"), return it
        if (!result.success) {
            return {
                ...result,
                elapsedMs: Date.now() - startTime,
                timedOut: false
            };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return {
        success: true,
        found: false,
        elapsedMs: Date.now() - startTime,
        timedOut: true,
        error: `Timed out after ${timeoutMs}ms waiting for element`
    };
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

// ============================================================================
// Accessibility Functions (UI Hierarchy)
// ============================================================================

/**
 * Android UI element from uiautomator dump
 */
export interface AndroidAccessibilityElement {
    class: string;
    text?: string;
    contentDesc?: string;
    resourceId?: string;
    bounds: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    };
    frame: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    tap: {
        x: number;
        y: number;
    };
    children: AndroidAccessibilityElement[];
    // Raw attributes for detailed view
    checkable?: boolean;
    checked?: boolean;
    clickable?: boolean;
    enabled?: boolean;
    focusable?: boolean;
    focused?: boolean;
    scrollable?: boolean;
    selected?: boolean;
}

/**
 * Result type for accessibility operations
 */
export interface AndroidDescribeResult {
    success: boolean;
    elements?: AndroidAccessibilityElement[];
    formatted?: string;
    error?: string;
}

/**
 * Simplify Android class name for display
 * android.widget.Button -> Button
 * android.widget.TextView -> TextView
 */
function simplifyClassName(className: string): string {
    if (!className) return "Unknown";
    const parts = className.split(".");
    return parts[parts.length - 1];
}

/**
 * Parse bounds string "[left,top][right,bottom]" to object
 */
function parseBounds(boundsStr: string): {
    left: number;
    top: number;
    right: number;
    bottom: number;
} | null {
    const match = boundsStr?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!match) return null;
    return {
        left: parseInt(match[1], 10),
        top: parseInt(match[2], 10),
        right: parseInt(match[3], 10),
        bottom: parseInt(match[4], 10)
    };
}

/**
 * Parse a single node from uiautomator XML
 */
function parseUiNode(node: Record<string, unknown>): AndroidAccessibilityElement | null {
    const attrs = node["@_bounds"]
        ? node
        : node.node
          ? (Array.isArray(node.node) ? node.node[0] : node.node)
          : null;

    if (!attrs) return null;

    const boundsStr = attrs["@_bounds"] as string;
    const bounds = parseBounds(boundsStr);
    if (!bounds) return null;

    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const centerX = Math.round(bounds.left + width / 2);
    const centerY = Math.round(bounds.top + height / 2);

    const element: AndroidAccessibilityElement = {
        class: simplifyClassName(attrs["@_class"] as string || ""),
        bounds,
        frame: {
            x: bounds.left,
            y: bounds.top,
            width,
            height
        },
        tap: {
            x: centerX,
            y: centerY
        },
        children: []
    };

    // Add optional attributes
    if (attrs["@_text"]) element.text = attrs["@_text"] as string;
    if (attrs["@_content-desc"]) element.contentDesc = attrs["@_content-desc"] as string;
    if (attrs["@_resource-id"]) element.resourceId = attrs["@_resource-id"] as string;
    if (attrs["@_checkable"] === "true") element.checkable = true;
    if (attrs["@_checked"] === "true") element.checked = true;
    if (attrs["@_clickable"] === "true") element.clickable = true;
    if (attrs["@_enabled"] === "true") element.enabled = true;
    if (attrs["@_focusable"] === "true") element.focusable = true;
    if (attrs["@_focused"] === "true") element.focused = true;
    if (attrs["@_scrollable"] === "true") element.scrollable = true;
    if (attrs["@_selected"] === "true") element.selected = true;

    return element;
}

/**
 * Recursively parse UI hierarchy from XML node
 */
function parseHierarchy(node: Record<string, unknown>): AndroidAccessibilityElement[] {
    const results: AndroidAccessibilityElement[] = [];

    // Handle the node itself
    if (node["@_bounds"]) {
        const element = parseUiNode(node);
        if (element) {
            // Parse children
            if (node.node) {
                const children = Array.isArray(node.node) ? node.node : [node.node];
                for (const child of children) {
                    element.children.push(...parseHierarchy(child as Record<string, unknown>));
                }
            }
            results.push(element);
        }
    } else if (node.node) {
        // This is a container without bounds (like hierarchy root)
        const children = Array.isArray(node.node) ? node.node : [node.node];
        for (const child of children) {
            results.push(...parseHierarchy(child as Record<string, unknown>));
        }
    }

    return results;
}

/**
 * Format accessibility tree for display (similar to iOS format)
 */
function formatAndroidAccessibilityTree(elements: AndroidAccessibilityElement[], indent: number = 0): string {
    const lines: string[] = [];
    const prefix = "  ".repeat(indent);

    for (const element of elements) {
        const parts: string[] = [];

        // [ClassName] "text" or "content-desc"
        parts.push(`[${element.class}]`);

        // Add label (text or content-desc)
        const label = element.text || element.contentDesc;
        if (label) {
            parts.push(`"${label}"`);
        }

        // Add frame and tap coordinates
        const f = element.frame;
        parts.push(`frame=(${f.x}, ${f.y}, ${f.width}x${f.height}) tap=(${element.tap.x}, ${element.tap.y})`);

        lines.push(`${prefix}${parts.join(" ")}`);

        // Recurse into children
        if (element.children.length > 0) {
            lines.push(formatAndroidAccessibilityTree(element.children, indent + 1));
        }
    }

    return lines.join("\n");
}

/**
 * Flatten element tree to array for searching
 */
function flattenElements(elements: AndroidAccessibilityElement[]): AndroidAccessibilityElement[] {
    const result: AndroidAccessibilityElement[] = [];
    for (const element of elements) {
        result.push(element);
        if (element.children.length > 0) {
            result.push(...flattenElements(element.children));
        }
    }
    return result;
}

/**
 * Get the UI hierarchy from the connected Android device using uiautomator dump
 */
export async function androidDescribeAll(deviceId?: string): Promise<AndroidDescribeResult> {
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

        // Use file-based approach (most reliable across devices)
        // /dev/tty doesn't work on most emulators/devices
        const remotePath = "/sdcard/ui_dump.xml";
        await execAsync(`adb ${deviceArg} shell uiautomator dump ${remotePath}`, {
            timeout: ADB_TIMEOUT
        });
        const { stdout } = await execAsync(`adb ${deviceArg} shell cat ${remotePath}`, {
            timeout: ADB_TIMEOUT,
            maxBuffer: 10 * 1024 * 1024
        });
        const xmlContent = stdout.trim();
        // Clean up
        await execAsync(`adb ${deviceArg} shell rm ${remotePath}`, {
            timeout: 5000
        }).catch(() => {});

        if (!xmlContent || !xmlContent.includes("<hierarchy")) {
            return {
                success: false,
                error: "Failed to get UI hierarchy. Make sure the device screen is unlocked and the app is in foreground."
            };
        }

        // Parse XML
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_"
        });
        const parsed = parser.parse(xmlContent);

        if (!parsed.hierarchy) {
            return {
                success: false,
                error: "Invalid UI hierarchy XML structure"
            };
        }

        const elements = parseHierarchy(parsed.hierarchy);
        const formatted = formatAndroidAccessibilityTree(elements);

        return {
            success: true,
            elements,
            formatted
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to get UI hierarchy: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get accessibility info for the UI element at specific coordinates
 */
export async function androidDescribePoint(
    x: number,
    y: number,
    deviceId?: string
): Promise<AndroidDescribeResult> {
    try {
        // First get the full hierarchy
        const result = await androidDescribeAll(deviceId);
        if (!result.success || !result.elements) {
            return result;
        }

        // Flatten and find elements containing the point
        const allElements = flattenElements(result.elements);

        // Find all elements whose bounds contain the point
        const matchingElements = allElements.filter((el) => {
            const b = el.bounds;
            return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
        });

        if (matchingElements.length === 0) {
            return {
                success: true,
                formatted: `No element found at (${x}, ${y})`
            };
        }

        // Return the deepest (smallest) element that contains the point
        // Sort by area (smallest first) to get the most specific element
        matchingElements.sort((a, b) => {
            const areaA = a.frame.width * a.frame.height;
            const areaB = b.frame.width * b.frame.height;
            return areaA - areaB;
        });

        const element = matchingElements[0];

        // Format detailed output
        const lines: string[] = [];
        const label = element.text || element.contentDesc;
        lines.push(`[${element.class}]${label ? ` "${label}"` : ""} frame=(${element.frame.x}, ${element.frame.y}, ${element.frame.width}x${element.frame.height}) tap=(${element.tap.x}, ${element.tap.y})`);

        if (element.resourceId) {
            lines.push(`  resource-id: ${element.resourceId}`);
        }
        if (element.contentDesc && element.text) {
            // Show content-desc separately if we showed text as label
            lines.push(`  content-desc: ${element.contentDesc}`);
        }
        if (element.text && element.contentDesc) {
            // Show text separately if we showed content-desc as label
            lines.push(`  text: ${element.text}`);
        }

        // Show state flags
        const flags: string[] = [];
        if (element.clickable) flags.push("clickable");
        if (element.enabled) flags.push("enabled");
        if (element.focusable) flags.push("focusable");
        if (element.focused) flags.push("focused");
        if (element.scrollable) flags.push("scrollable");
        if (element.selected) flags.push("selected");
        if (element.checked) flags.push("checked");
        if (flags.length > 0) {
            lines.push(`  state: ${flags.join(", ")}`);
        }

        return {
            success: true,
            elements: [element],
            formatted: lines.join("\n")
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to describe point: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Tap an element by its text, content-description, or resource-id
 */
export async function androidTapElement(
    options: {
        text?: string;
        textContains?: string;
        contentDesc?: string;
        contentDescContains?: string;
        resourceId?: string;
        index?: number;
        deviceId?: string;
    }
): Promise<AdbResult> {
    try {
        const { text, textContains, contentDesc, contentDescContains, resourceId, index = 0, deviceId } = options;

        // Validate that at least one search criterion is provided
        if (!text && !textContains && !contentDesc && !contentDescContains && !resourceId) {
            return {
                success: false,
                error: "At least one of text, textContains, contentDesc, contentDescContains, or resourceId must be provided"
            };
        }

        // Get the UI hierarchy
        const result = await androidDescribeAll(deviceId);
        if (!result.success || !result.elements) {
            return {
                success: false,
                error: result.error || "Failed to get UI hierarchy"
            };
        }

        // Flatten and search
        const allElements = flattenElements(result.elements);

        // Filter elements based on search criteria
        const matchingElements = allElements.filter((el) => {
            if (text && el.text !== text) return false;
            if (textContains && (!el.text || !el.text.toLowerCase().includes(textContains.toLowerCase()))) return false;
            if (contentDesc && el.contentDesc !== contentDesc) return false;
            if (contentDescContains && (!el.contentDesc || !el.contentDesc.toLowerCase().includes(contentDescContains.toLowerCase()))) return false;
            if (resourceId) {
                // Support both full resource-id and short form
                if (!el.resourceId) return false;
                if (el.resourceId !== resourceId && !el.resourceId.endsWith(`:id/${resourceId}`)) return false;
            }
            return true;
        });

        if (matchingElements.length === 0) {
            const criteria: string[] = [];
            if (text) criteria.push(`text="${text}"`);
            if (textContains) criteria.push(`textContains="${textContains}"`);
            if (contentDesc) criteria.push(`contentDesc="${contentDesc}"`);
            if (contentDescContains) criteria.push(`contentDescContains="${contentDescContains}"`);
            if (resourceId) criteria.push(`resourceId="${resourceId}"`);
            return {
                success: false,
                error: `Element not found: ${criteria.join(", ")}`
            };
        }

        if (index >= matchingElements.length) {
            return {
                success: false,
                error: `Index ${index} out of range. Found ${matchingElements.length} matching element(s).`
            };
        }

        const element = matchingElements[index];
        const label = element.text || element.contentDesc || element.resourceId || element.class;

        // Log if multiple matches
        let resultMessage: string;
        if (matchingElements.length > 1) {
            resultMessage = `Found ${matchingElements.length} elements, tapping "${label}" (index ${index}) at (${element.tap.x}, ${element.tap.y})`;
        } else {
            resultMessage = `Tapped "${label}" at (${element.tap.x}, ${element.tap.y})`;
        }

        // Perform the tap
        const tapResult = await androidTap(element.tap.x, element.tap.y, deviceId);
        if (!tapResult.success) {
            return tapResult;
        }

        return {
            success: true,
            result: resultMessage
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to tap element: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
