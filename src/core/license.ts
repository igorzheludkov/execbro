import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { homedir, platform, hostname, release } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getInstallationId } from "./telemetry.js";
import { getDeviceFingerprint, getFingerprintVersion } from "./fingerprint.js";

// ============================================================================
// Configuration
// ============================================================================

import { API_BASE_URL } from "./config.js";

const IS_DEV = process.argv.includes("--http");
const CACHE_TTL_MS = IS_DEV ? 0 : 24 * 60 * 60 * 1000; // No cache in dev, 24h in prod
const VALIDATION_ENDPOINT = API_BASE_URL;
const REGISTRATION_ENDPOINT = API_BASE_URL;
const ACCOUNTS_API_KEY = "fb4b5d8f410ff8d0dfe3ade01adc0b2444479ac9380b3f256554dd9d7044f5d2";
const API_TIMEOUT_MS = 5_000;
const LICENSE_FILE = join(homedir(), ".rn-ai-debugger", "license.json");
const DASHBOARD_URL = API_BASE_URL;

// ============================================================================
// Types
// ============================================================================

export type LicenseTier = "free" | "pro" | "team";

export interface LicenseStatus {
    installationId: string;
    tier: LicenseTier;
    accountStatus: "anonymous" | "linked";
    validatedAt: string;
    cacheExpiresAt: string;
    plan?: {
        name: string;
        expiresAt: string;
    };
}

interface ApiResponse {
    tier: LicenseTier;
    error?: string;
    plan?: {
        name: string;
        expiresAt: string;
    } | null;
    validatedAt: string;
    cacheExpiresAt: string;
}

// ============================================================================
// State
// ============================================================================

let currentStatus: LicenseStatus | null = null;

// ============================================================================
// Cache Management
// ============================================================================

function readCache(): LicenseStatus | null {
    try {
        if (!existsSync(LICENSE_FILE)) return null;
        const data = readFileSync(LICENSE_FILE, "utf-8");
        const parsed = JSON.parse(data) as LicenseStatus;
        // Validate required fields
        if (!parsed.installationId || !parsed.tier || !parsed.cacheExpiresAt) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(status: LicenseStatus): void {
    try {
        const dir = dirname(LICENSE_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(LICENSE_FILE, JSON.stringify(status, null, 2));
    } catch {
        // Silently fail — cache write is best-effort
    }
}

function isCacheFresh(cache: LicenseStatus, installationId: string): boolean {
    if (cache.installationId !== installationId) return false;
    return new Date(cache.cacheExpiresAt).getTime() > Date.now();
}

function createDefaultStatus(installationId: string): LicenseStatus {
    const now = new Date().toISOString();
    return {
        installationId,
        tier: "free",
        accountStatus: "anonymous",
        validatedAt: now,
        cacheExpiresAt: now, // Already expired — will trigger API call next startup
    };
}

// ============================================================================
// Registration
// ============================================================================

let registrationAttempted = false;

async function registerInstallation(installationId: string): Promise<void> {
    if (registrationAttempted || !REGISTRATION_ENDPOINT) return;
    registrationAttempted = true;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        await fetch(`${REGISTRATION_ENDPOINT}/api/accounts/register`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": ACCOUNTS_API_KEY,
            },
            body: JSON.stringify({
                installationId,
                fingerprint: getDeviceFingerprint(),
                fingerprintVersion: getFingerprintVersion(),
                platform: platform(),
                serverVersion: getServerVersion(),
                hostname: hostname(),
                osVersion: `${platform()} ${release()}`,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);
    } catch {
        registrationAttempted = false;
    }
}

function getServerVersion(): string {
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}

// ============================================================================
// API Validation
// ============================================================================

async function callValidationApi(installationId: string): Promise<ApiResponse | null> {
    if (!VALIDATION_ENDPOINT) return null;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        const response = await fetch(`${VALIDATION_ENDPOINT}/api/license/validate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": ACCOUNTS_API_KEY,
            },
            body: JSON.stringify({
                installationId,
                fingerprint: getDeviceFingerprint(),
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok && response.status !== 200) {
            return null;
        }

        return (await response.json()) as ApiResponse;
    } catch {
        return null;
    }
}

// ============================================================================
// Public API
// ============================================================================

let licensePromise: Promise<LicenseResult> | null = null;

interface LicenseResult {
    status: LicenseStatus;
    source: "cache" | "api" | "default";
    durationMs: number;
}

/**
 * Lazy, idempotent license check — called on first real tool use.
 * Returns cached result on subsequent calls.
 */
export function ensureLicense(): Promise<LicenseResult> {
    if (!licensePromise) {
        licensePromise = resolveLicense();
    }
    return licensePromise;
}

async function resolveLicense(): Promise<LicenseResult> {
    const startTime = Date.now();
    const installationId = getInstallationId();

    // Fire-and-forget registration on first run
    registerInstallation(installationId);

    const cache = readCache();
    let source: "cache" | "api" | "default" = "default";

    // Check if cache is fresh and matches current installation
    if (cache && isCacheFresh(cache, installationId)) {
        currentStatus = cache;
        source = "cache";
        return { status: currentStatus, source, durationMs: Date.now() - startTime };
    }

    // Cache stale or missing — try API
    const apiResponse = await callValidationApi(installationId);

    if (apiResponse) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

        currentStatus = {
            installationId,
            tier: apiResponse.tier,
            accountStatus: "anonymous",
            validatedAt: apiResponse.validatedAt || now.toISOString(),
            cacheExpiresAt: apiResponse.cacheExpiresAt || expiresAt.toISOString(),
            plan: apiResponse.plan || undefined,
        };

        writeCache(currentStatus);
        source = "api";
        return { status: currentStatus, source, durationMs: Date.now() - startTime };
    }

    // API failed — fall back to stale cache (fail open)
    if (cache && cache.installationId === installationId) {
        currentStatus = cache;
        source = "cache";
        return { status: currentStatus, source, durationMs: Date.now() - startTime };
    }

    // No cache, no API — default to free
    currentStatus = createDefaultStatus(installationId);
    writeCache(currentStatus);
    return { status: currentStatus, source, durationMs: Date.now() - startTime };
}

export function getLicenseStatus(): LicenseStatus {
    if (!currentStatus) {
        // Called before ensureLicense() resolved — return default free tier
        const installationId = getInstallationId();
        currentStatus = createDefaultStatus(installationId);
    }
    return currentStatus;
}

export function getDashboardUrl(): string {
    return DASHBOARD_URL;
}

export function resetLicense(): void {
    currentStatus = null;
    licensePromise = null;
    registrationAttempted = false;
    try {
        if (existsSync(LICENSE_FILE)) {
            unlinkSync(LICENSE_FILE);
        }
    } catch {
        // Best-effort cleanup
    }
}
