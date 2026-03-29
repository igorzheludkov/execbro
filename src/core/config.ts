import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_FILE = join(homedir(), ".rn-ai-debugger", "config.json");
const IS_DEV = process.argv.includes("--http");

const PRODUCTION_URL = "https://mobile-ai-devtools.link";
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
 * 1. config.json apiUrl (if set)
 * 2. --http flag → localhost:3000
 * 3. Default → production URL
 */
export const API_BASE_URL: string =
    config.apiUrl ?? (IS_DEV ? LOCAL_URL : PRODUCTION_URL);
