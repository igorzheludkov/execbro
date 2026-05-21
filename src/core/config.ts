import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths.js";

const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const IS_DEV = process.argv.includes("--http");

const PRODUCTION_URL = "https://execbro.com";
const LOCAL_URL = "http://localhost:3000";

interface Config {
    apiUrl?: string;
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
