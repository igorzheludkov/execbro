import { existsSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const NEW_DIR = join(homedir(), ".execbro");
const LEGACY_DIR = join(homedir(), ".rn-ai-debugger");

let migrationAttempted = false;

function migrateLegacyConfigDir(): void {
    if (migrationAttempted) return;
    migrationAttempted = true;
    try {
        if (!existsSync(NEW_DIR) && existsSync(LEGACY_DIR)) {
            renameSync(LEGACY_DIR, NEW_DIR);
        }
    } catch {
        // best-effort migration; resolveConfigDir() falls back to legacy if rename failed
    }
}

migrateLegacyConfigDir();

function resolveConfigDir(): string {
    if (!existsSync(NEW_DIR) && existsSync(LEGACY_DIR)) {
        return LEGACY_DIR;
    }
    return NEW_DIR;
}

export const CONFIG_DIR = resolveConfigDir();
