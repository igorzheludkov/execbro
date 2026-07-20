import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { platform, hostname, release } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getInstallationId } from "./telemetry.js";
import { getDeviceFingerprint, getFingerprintVersion } from "./fingerprint.js";
import { getPostHogClient } from "./posthog.js";
import { CONFIG_DIR } from "./paths.js";

// ============================================================================
// Configuration
// ============================================================================

import { API_BASE_URL } from "./config.js";

const IS_DEV = process.argv.includes("--http");
const CACHE_TTL_MS = IS_DEV ? 0 : 24 * 60 * 60 * 1000; // No cache in dev, 24h in prod
const VALIDATION_ENDPOINT = API_BASE_URL;
const ACCOUNTS_API_KEY = "fb4b5d8f410ff8d0dfe3ade01adc0b2444479ac9380b3f256554dd9d7044f5d2";
const API_TIMEOUT_MS = 5_000;
const LICENSE_FILE = join(CONFIG_DIR, "license.json");
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

export interface UsageInfo {
    used: number;
    limit: number | null;
    monthKey: string;
    creditsRemaining: number | null;
    canUse: boolean;
    promotionalPeriod?: boolean;
    promotionalPeriodEndsAt?: string | null;
    // Metered-freemium additions:
    resetsAt?: string;
    warnThreshold?: number;
    capActive?: boolean;
    enforcementStartsAt?: string | null;
    // Stamped locally at write time; drives the fail-closed grace window.
    verdictFreshUntil?: string;
}

export interface PlanPricing {
    amount: number;
    currency: string;
    interval: "month" | "year";
}

export interface PricingInfo {
    pro?: PlanPricing;
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

const USAGE_FILE = join(CONFIG_DIR, "usage.json");

let currentUsage: UsageInfo | null = null;
let currentPricing: PricingInfo | null = null;

export function getUsageInfo(): UsageInfo | null {
    return currentUsage;
}

export function getPricingInfo(): PricingInfo | null {
    return currentPricing;
}

export function formatPlanPrice(p: PlanPricing): string {
    const symbol = p.currency === "USD" ? "$" : `${p.currency} `;
    const period = p.interval === "month" ? "mo" : "yr";
    return `${symbol}${p.amount}/${period}`;
}

export const GRACE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h fail-closed grace

// Offline verdict resolution. Within the grace window we trust the last server
// verdict verbatim (including canUse:false — this is the anti-bypass reversal of
// the old "never load stale usage" behavior). Past the window we block only if the
// last-known state was over cap; deferred (capActive:false) users are never blocked.
export function computeOfflineUsage(cached: UsageInfo | null, now: number): UsageInfo | null {
    if (!cached) return null;
    const fresh = cached.verdictFreshUntil ? new Date(cached.verdictFreshUntil).getTime() : 0;
    if (now < fresh) return cached;
    // The cap is monthly — if we've rolled into a new calendar month (UTC) since
    // the cached verdict, the counter has reset server-side even though we can't
    // reach the API to confirm it, so don't keep blocking on last month's usage.
    if (cached.monthKey) {
        const d = new Date(now);
        const currentMonthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        if (cached.monthKey !== currentMonthKey) {
            return { ...cached, canUse: true };
        }
    }
    const overCap = cached.capActive !== false && cached.limit != null && cached.used >= cached.limit;
    return { ...cached, canUse: !overCap };
}

function readUsageCache(): UsageInfo | null {
    try {
        if (!existsSync(USAGE_FILE)) return null;
        return JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
    } catch {
        return null;
    }
}

function writeUsageCache(usage: UsageInfo): void {
    try {
        const dir = dirname(USAGE_FILE);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
    } catch {
        // Silent fail
    }
}

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

function getPackageName(): string {
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.name || "unknown";
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
                fingerprintVersion: getFingerprintVersion(),
                platform: platform(),
                serverVersion: getServerVersion(),
                hostname: hostname(),
                osVersion: `${platform()} ${release()}`,
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

// Force a fresh validate, bypassing the per-process memo but WITHOUT clearing the
// cache first (unlike resetLicense) — so if the API is unreachable, resolveLicense()
// still falls back to the last-known verdict instead of dropping to free. Lets
// get_license_status pick up a mid-session dashboard upgrade without an MCP restart.
export function refreshLicense(): Promise<LicenseResult> {
    licensePromise = resolveLicense();
    return licensePromise;
}

async function resolveLicense(): Promise<LicenseResult> {
    const startTime = Date.now();
    const installationId = getInstallationId();

    const cache = readCache();
    let source: "cache" | "api" | "default" = "default";

    // Always call API for fresh usage data (even if license cache is fresh)
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

        // Identify user in PostHog for segmentation
        getPostHogClient()?.identify({
            distinctId: installationId,
            properties: {
                platform: platform(),
                server_version: getServerVersion(),
                package_name: getPackageName(),
                tier: apiResponse.tier,
                os_version: `${platform()} ${release()}`,
                $set: { package_name: getPackageName() },
            },
        });

        // Parse usage info from API response
        if ((apiResponse as any).usage) {
            const usageData = (apiResponse as any).usage as UsageInfo;
            usageData.verdictFreshUntil = new Date(Date.now() + GRACE_WINDOW_MS).toISOString();
            currentUsage = usageData;
            writeUsageCache(usageData);
        }

        if ((apiResponse as any).pricing) {
            currentPricing = (apiResponse as any).pricing as PricingInfo;
        }

        return { status: currentStatus, source, durationMs: Date.now() - startTime };
    }

    // API failed — fall back to stale license cache (fail open on tier).
    if (cache && cache.installationId === installationId) {
        currentStatus = cache;
        source = "cache";
        // Fail-closed-after-grace: reuse the last usage verdict within the grace
        // window; past it, block only if last-known over cap. (Replaces the old
        // fail-open no-op which let anyone bypass the cap by blocking the endpoint.)
        currentUsage = computeOfflineUsage(readUsageCache(), Date.now());
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

export function incrementLocalUsage(): void {
    if (!currentUsage) return;
    currentUsage.used += 1;
    // Write periodically, not on every call (write every 10 increments)
    if (currentUsage.used % 10 === 0) {
        writeUsageCache(currentUsage);
    }
}

export function getDashboardUrl(): string {
    return DASHBOARD_URL;
}

// Mints a short-lived, single-use link token bound to this installation's
// fingerprint, so the printed /link URL can't be redeemed by anyone who just
// sees it — only someone who can also prove they hold this machine's fingerprint.
export async function requestLinkToken(): Promise<string | null> {
    if (!VALIDATION_ENDPOINT) return null;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        const response = await fetch(`${VALIDATION_ENDPOINT}/api/accounts/link-token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": ACCOUNTS_API_KEY,
            },
            body: JSON.stringify({
                installationId: getInstallationId(),
                fingerprint: getDeviceFingerprint(),
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);
        if (!response.ok) return null;

        const data = (await response.json()) as { token?: string };
        return typeof data.token === "string" ? data.token : null;
    } catch {
        return null;
    }
}

export function resetLicense(): void {
    currentStatus = null;
    licensePromise = null;
    try {
        if (existsSync(LICENSE_FILE)) {
            unlinkSync(LICENSE_FILE);
        }
    } catch {
        // Best-effort cleanup
    }
}
