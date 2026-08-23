import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths.js";
import { isPublishedBuild } from "./buildInfo.js";

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
 * 3. --http flag -> localhost:3000
 * 4. Default -> production URL
 *
 * In a PUBLISHED build both overrides are ignored. They are supported
 * configuration, which made them a bypass switch: an agent asked to remove the
 * free-tier limit can point the client at a local server that answers
 * `{"tier":"pro"}`, and unlike a patched package that survives every update.
 * Ignoring the override demotes the vector to editing build/core/config.js,
 * which is the already-excluded attacker class and self-heals on the next
 * `npx execbro@latest`. A source checkout or fork keeps the placeholder
 * BUILD_TOKEN, so the dev loop (scripts/dev-server.sh sets EXECBRO_API_URL)
 * is unaffected.
 *
 * Ignore and warn, never exit: a hard exit is a worse failure mode than a
 * warning for a user who set the variable for a reason we did not anticipate.
 *
 * This is a release-channel gate, not a security boundary, exactly like the
 * --http transport gate in src/index.ts.
 *
 * `||` rather than `??` on purpose: an empty-string override must read as
 * absent, or EXECBRO_API_URL="" resolves to an empty base URL and every
 * request goes to a relative path.
 */
export function resolveApiBaseUrl(opts: {
    envUrl?: string;
    configUrl?: string;
    published: boolean;
    devMode: boolean;
}): { url: string; overrideIgnored: boolean } {
    const override = opts.envUrl || opts.configUrl;
    if (override && opts.published) {
        return { url: PRODUCTION_URL, overrideIgnored: true };
    }
    return { url: override ?? (opts.devMode ? LOCAL_URL : PRODUCTION_URL), overrideIgnored: false };
}

const resolvedApi = resolveApiBaseUrl({
    envUrl: process.env.EXECBRO_API_URL,
    configUrl: config.apiUrl,
    published: isPublishedBuild(),
    devMode: IS_DEV,
});

if (resolvedApi.overrideIgnored) {
    console.error(
        `[execbro] Ignoring API URL override in a published build; using ${PRODUCTION_URL}. ` +
            `Build from source if you need to point ExecBro at another backend.`,
    );
}

export const API_BASE_URL: string = resolvedApi.url;

// Write-only server API key shared by license validation and metering reports.
// Safe to embed in client code (grants no read access).
export const ACCOUNTS_API_KEY = "fb4b5d8f410ff8d0dfe3ade01adc0b2444479ac9380b3f256554dd9d7044f5d2";

/** Local project-memory store is on unless config.json sets it to exactly false. */
export function isProjectMemoryEnabled(): boolean {
    return config.projectMemory?.enabled !== false;
}
