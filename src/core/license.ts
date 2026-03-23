import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { getInstallationId } from "./telemetry.js";

// ============================================================================
// Configuration
// ============================================================================

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VALIDATION_ENDPOINT = ""; // Placeholder — set when backend is built
const API_TIMEOUT_MS = 5_000;
const LICENSE_FILE = join(homedir(), ".rn-ai-debugger", "license.json");
const DASHBOARD_URL = ""; // Placeholder — set when dashboard is built

// ============================================================================
// Types
// ============================================================================

export type LicenseTier = "free" | "pro" | "team";

export interface LicenseStatus {
    installationId: string;
    status: LicenseTier;
    validatedAt: string;
    cacheExpiresAt: string;
    plan?: {
        name: string;
        expiresAt: string;
    };
}

interface ApiResponse {
    status: LicenseTier;
    plan?: {
        name: string;
        expiresAt: string;
    };
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
        if (!parsed.installationId || !parsed.status || !parsed.cacheExpiresAt) {
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
        status: "free",
        validatedAt: now,
        cacheExpiresAt: now, // Already expired — will trigger API call next startup
    };
}

// ============================================================================
// API Validation
// ============================================================================

async function callValidationApi(installationId: string): Promise<ApiResponse | null> {
    // Skip if endpoint not configured
    if (!VALIDATION_ENDPOINT) return null;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        const response = await fetch(
            `${VALIDATION_ENDPOINT}/validate?installationId=${encodeURIComponent(installationId)}`,
            { signal: controller.signal }
        );

        clearTimeout(timeout);

        if (response.status === 404) {
            return { status: "free" };
        }

        if (!response.ok) {
            return null; // 5xx or unexpected — fail open
        }

        return (await response.json()) as ApiResponse;
    } catch {
        return null; // Network error, timeout — fail open
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
            status: apiResponse.status,
            validatedAt: now.toISOString(),
            cacheExpiresAt: expiresAt.toISOString(),
            plan: apiResponse.plan,
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
