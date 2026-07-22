import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths.js";

const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const IS_DEV = process.argv.includes("--http");

const PRODUCTION_URL = "https://execbro.com";
const LOCAL_URL = "http://localhost:3000";

interface Config {
    apiUrl?: string;
    projectMemory?: { enabled?: boolean };
}

function loadConfig(): Config {
    if (!existsSync(CONFIG_FILE)) return {};
    try {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

const config = loadConfig();

/**
 * Resolution order:
 * 1. EXECBRO_API_URL env var (if set)
 * 2. config.json apiUrl (if set)
 * 3. --http flag → localhost:3000
 * 4. Default → production URL
 */
export const API_BASE_URL: string =
    process.env.EXECBRO_API_URL ?? config.apiUrl ?? (IS_DEV ? LOCAL_URL : PRODUCTION_URL);

// Write-only server API key shared by license validation and metering reports.
// Safe to embed in client code (grants no read access).
export const ACCOUNTS_API_KEY = "fb4b5d8f410ff8d0dfe3ade01adc0b2444479ac9380b3f256554dd9d7044f5d2";

/** Local project-memory store is on unless config.json sets it to exactly false. */
export function isProjectMemoryEnabled(): boolean {
    return config.projectMemory?.enabled !== false;
}
