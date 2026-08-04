import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A running emulator's gRPC bridge: the port it listens on and the bearer
 * token that authorises calls to it.
 */
export interface EmulatorBridge {
    port: number;
    token: string;
    avdName?: string;
}

export type BridgeFailureReason =
    | "not-emulator"
    | "unsupported-host"
    | "no-discovery-file"
    | "no-grpc-keys";

export type BridgeResolution =
    | { ok: true; bridge: EmulatorBridge }
    | { ok: false; reason: BridgeFailureReason; message: string };

/**
 * Where the emulator writes one `pid_<pid>.ini` per running instance.
 *
 * Only the macOS location is verified. The Linux and Windows paths are
 * plausible but untested, and a wrong guess would read someone else's file,
 * so unverified hosts resolve to null and fail loudly instead.
 */
export function emulatorRunningDir(
    platform: NodeJS.Platform = process.platform,
    home: string = homedir()
): string | null {
    if (platform === "darwin") {
        return join(home, "Library", "Caches", "TemporaryItems", "avd", "running");
    }
    return null;
}

/** Parse `key=value` lines. Values may contain '=' (base64 tokens do). */
function parseIni(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
}

/**
 * Map an adb serial to its emulator's gRPC bridge.
 *
 * `emulator-5554` names the console port, which is what the discovery file
 * records as `port.serial` — that is the only reliable join between adb's
 * view of a device and the emulator's own.
 */
export async function resolveEmulatorBridge(
    serial: string,
    runningDir?: string
): Promise<BridgeResolution> {
    const match = /^emulator-(\d+)$/.exec(serial.trim());
    if (!match) {
        return {
            ok: false,
            reason: "not-emulator",
            message:
                `'${serial}' is a physical Android device. Multi-touch needs the emulator's ` +
                `gRPC bridge, which physical devices do not expose. Run the app on an emulator to use pinch.`,
        };
    }
    const consolePort = match[1];

    const dir = runningDir ?? emulatorRunningDir();
    if (!dir) {
        return {
            ok: false,
            reason: "unsupported-host",
            message:
                `The emulator discovery directory is only verified on macOS, so pinch is not ` +
                `enabled on ${process.platform} yet.`,
        };
    }

    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        entries = [];
    }

    for (const name of entries) {
        if (!name.startsWith("pid_") || !name.endsWith(".ini")) continue;
        let ini: Record<string, string>;
        try {
            ini = parseIni(await readFile(join(dir, name), "utf8"));
        } catch {
            continue;
        }
        if (ini["port.serial"] !== consolePort) continue;

        const port = Number(ini["grpc.port"]);
        const token = ini["grpc.token"];
        if (!Number.isInteger(port) || port <= 0 || !token) {
            return {
                ok: false,
                reason: "no-grpc-keys",
                message:
                    `${name} has no gRPC bridge (missing grpc.port/grpc.token). The emulator is ` +
                    `too old or was started with gRPC disabled; pinch needs a version that exposes it.`,
            };
        }
        return { ok: true, bridge: { port, token, avdName: ini["avd.name"] } };
    }

    return {
        ok: false,
        reason: "no-discovery-file",
        message:
            `No emulator discovery file in ${dir} matches console port ${consolePort}. ` +
            `Expected a pid_*.ini with port.serial=${consolePort}.`,
    };
}
