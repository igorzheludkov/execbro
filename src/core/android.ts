import { exec } from "child_process";
import { promisify } from "util";
import { readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

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
