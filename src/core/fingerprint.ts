import { createHash, randomUUID } from "crypto";
import { userInfo, cpus, platform } from "os";
import { execFileSync } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths.js";

const FINGERPRINT_VERSION = 1;

// Only imports ./paths.js (which imports nothing local) — keep it that way.
// Reaching for getInstallationId() from telemetry.js would close the cycle
// fingerprint -> telemetry -> license -> fingerprint.
const SALT_FILE = join(CONFIG_DIR, "fingerprint-salt.json");

let degraded = false;
let degradedResolved = false;
let saltCache: string | null = null;

export function getMachineId(): string {
    const os = platform();

    try {
        if (os === "darwin") {
            const output = execFileSync("system_profiler", ["SPHardwareDataType"], {
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
            const output = execFileSync(
                "reg",
                ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
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

/**
 * Random per-install salt, used only when no hardware machine id is available.
 *
 * Without it the degraded fingerprint is sha256(username + cpuModel) — which in
 * a container is sha256("root" + "<cloud CPU model>"), i.e. *identical* for every
 * unrelated user on that image. The server groups monthly usage by fingerprint
 * (fetchDeviceGroupMonthlyUsageCount), so a shared value pools strangers into one
 * device group and one 600-call quota, and they lock each other out of the free
 * tier. A random salt keeps degraded installs unique: the group is a group of one.
 *
 * If CONFIG_DIR is not writable the salt lives for the process only. That is the
 * correct trade: a per-process identity under-counts usage for a truly ephemeral
 * install, while a shared identity blocks innocent users. Never collide.
 */
function loadOrCreateDegradedSalt(): string {
    if (saltCache) return saltCache;

    try {
        if (existsSync(SALT_FILE)) {
            const parsed = JSON.parse(readFileSync(SALT_FILE, "utf-8")) as { salt?: string };
            if (parsed.salt) {
                saltCache = parsed.salt;
                return saltCache;
            }
        }
    } catch {
        // Missing or corrupted — fall through and mint a fresh salt.
    }

    const salt = randomUUID();
    try {
        if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(
            SALT_FILE,
            JSON.stringify({ _comment: "machine-managed by execbro — do not edit", salt }, null, 2),
        );
    } catch {
        // Unwritable config dir — process-scoped salt. Still unique, still safe.
    }

    saltCache = salt;
    return salt;
}

export function getDeviceFingerprint(): string {
    const username = userInfo().username;
    const cpuModel = cpus()[0]?.model ?? "unknown";
    const machineId = getMachineId();

    degradedResolved = true;

    if (machineId) {
        degraded = false;
        return createHash("sha256").update(username + cpuModel + machineId).digest("hex");
    }

    // No stable hardware signal. Salt the hash so this install cannot be grouped
    // with anyone else's — see loadOrCreateDegradedSalt().
    if (!degraded) {
        console.warn("[execbro] Device fingerprint: machineId unavailable, using degraded per-install fingerprint");
    }
    degraded = true;
    return createHash("sha256").update(username + cpuModel + loadOrCreateDegradedSalt()).digest("hex");
}

/**
 * True when the fingerprint carries no hardware signal, so the server should not
 * treat it as evidence that two installations are the same physical device.
 * Order-independent: resolves the fingerprint first if it has not been computed.
 */
export function isFingerprintDegraded(): boolean {
    if (!degradedResolved) getDeviceFingerprint();
    return degraded;
}

export function getFingerprintVersion(): number {
    return FINGERPRINT_VERSION;
}
