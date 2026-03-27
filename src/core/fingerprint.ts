import { createHash } from "crypto";
import { userInfo, cpus, platform } from "os";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

const FINGERPRINT_VERSION = 1;

export function getMachineId(): string {
    const os = platform();

    try {
        if (os === "darwin") {
            const output = execSync("system_profiler SPHardwareDataType", {
                encoding: "utf-8",
                timeout: 5000,
            });
            const match = output.match(/Hardware UUID:\s*(.+)/);
            return match ? match[1].trim() : "";
        }

        if (os === "linux") {
            if (existsSync("/etc/machine-id")) {
                return readFileSync("/etc/machine-id", "utf-8").trim();
            }
            return "";
        }

        if (os === "win32") {
            const output = execSync(
                'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
                { encoding: "utf-8", timeout: 5000 },
            );
            const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
            return match ? match[1].trim() : "";
        }

        return "";
    } catch {
        return "";
    }
}

export function getDeviceFingerprint(): string {
    const username = userInfo().username;
    const cpuModel = cpus()[0]?.model ?? "unknown";
    const machineId = getMachineId();

    if (!machineId) {
        console.warn("[rn-ai-debugger] Device fingerprint: machineId unavailable, using degraded fingerprint");
    }

    const input = username + cpuModel + machineId;
    return createHash("sha256").update(input).digest("hex");
}

export function getFingerprintVersion(): number {
    return FINGERPRINT_VERSION;
}
