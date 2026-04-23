import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ensureLicense, incrementLocalUsage } from "./license.js";
import { connectedApps } from "./state.js";
import { getPostHogClient } from "./posthog.js";

// ============================================================================
// Configuration
// ============================================================================

const TELEMETRY_ENDPOINT = "https://rn-debugger-telemetry.500griven.workers.dev";
const TELEMETRY_API_KEY = "6a630181cb391ed5c42a188428cc2d2623dfe9333ec048193bb711ab58afe85e";

const REQUEST_TIMEOUT_MS = 5_000;
const CONFIG_DIR = join(homedir(), ".rn-ai-debugger");
const CONFIG_FILE = join(CONFIG_DIR, "telemetry.json");
export const TELEMETRY_JSONL_PATH = "/tmp/rn-devtools-telemetry.jsonl";

// Read version from package.json dynamically
export function getServerVersion(): string {
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}

// Read package name from package.json — differentiates canonical vs mirror publishes
export function getPackageName(): string {
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
// Types
// ============================================================================

type ErrorCategory = 'network' | 'timeout' | 'validation' | 'execution' | 'connection' | 'driver_missing' | 'unknown';

interface TelemetryEvent {
    name: string;
    timestamp: number;
    toolName?: string;
    success?: boolean;
    duration?: number;
    isFirstRun?: boolean;
    errorCategory?: ErrorCategory;
    errorMessage?: string;
    errorContext?: string; // Additional context like the expression that caused the error
    inputTokens?: number;
    outputTokens?: number;
    targetPlatform?: string;
    emptyResult?: boolean;
    meaningful?: boolean; // tap verification: did the tap cause visual change?
    changeRate?: number; // tap verification: percentage of pixels changed (0-1)
    tapStrategy?: string; // tap: winning strategy (fiber, ocr, accessibility, coordinate, etc.)
    iosDriver?: string; // tap: which iOS UI driver was used (idb, axe)
    emptyReason?: string; // get_logs: why the result was empty (no_logs, post_reconnect, pipeline_recovered, pipeline_failed, disconnected)
    properties?: Record<string, string | number | boolean>;
}

// ============================================================================
// Error Categorization
// ============================================================================

export function categorizeError(errorMessage: string, errorContext?: string): ErrorCategory {
    const lower = errorMessage.toLowerCase();
    // UI driver not installed (idb/axe) — must be checked before 'validation' which matches 'missing'/'install'
    if (lower.includes('not installed') && (lower.includes('idb') || lower.includes('axe') || lower.includes('ui driver'))) {
        return 'driver_missing';
    }
    // Strategy chain may contain driver-missing signals even when the primary error
    // message doesn't (e.g., strategies skipped due to missing driver, last-resort
    // strategy fails with "No element found" or "timed out")
    if (errorContext) {
        const ctxLower = errorContext.toLowerCase();
        if (ctxLower.includes('ios ui driver is not instal') || ctxLower.includes('idb is not instal')) {
            return 'driver_missing';
        }
    }
    if (lower.includes('websocket') || lower.includes('econnrefused') || lower.includes('socket') || lower.includes('fetch')) {
        return 'network';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
        return 'timeout';
    }
    // Check connection errors before validation (since "no debuggable devices found" contains "no")
    if (lower.includes('no apps connected') || lower.includes('scan_metro') || lower.includes('not connected') ||
        lower.includes('no debuggable devices') || lower.includes('no metro server') || lower.includes('connection failed')) {
        return 'connection';
    }
    // Syntax/compilation errors in JS code
    if (lower.includes('compiling js failed') || lower.includes('syntaxerror')) {
        return 'validation';
    }
    if (lower.includes('invalid') || lower.includes('required') || lower.includes('missing')) {
        return 'validation';
    }
    if (lower.includes('evaluate') || lower.includes('execution') || lower.includes('runtime')) {
        return 'execution';
    }
    // Tap element-not-found errors
    if (lower.includes('no element found') || lower.includes('no pressable') || lower.includes('no focusable')) {
        return 'validation';
    }
    // Tap connection errors (different message format from other tools)
    if (lower.includes('no connected app') || lower.includes('connect_metro first') || lower.includes('auto-connect failed')) {
        return 'connection';
    }
    return 'unknown';
}

interface TelemetryConfig {
    installationId: string;
    firstRunTimestamp: number;
    isFirstRun: boolean;
    devMode?: boolean;
    internal?: boolean;
}

interface TelemetryPayload {
    installationId: string;
    sessionId?: string;
    serverVersion: string;
    packageName: string;
    nodeVersion: string;
    platform: string;
    events: TelemetryEvent[];
}

// ============================================================================
// State
// ============================================================================

let telemetryEnabled = true;
let config: TelemetryConfig | null = null;
let sessionStartTime: number | null = null;
let sessionId: string | null = null;
let isFirstRunSession = false;
let sessionStarted = false;
let lastToolTimestamp: number | null = null;
const SESSION_INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes — matches dashboard SESSION_TIMEOUT_MS

// ============================================================================
// Configuration Management
// ============================================================================

function loadOrCreateConfig(): TelemetryConfig {
    if (config) return config;

    // Try to load existing config
    try {
        if (existsSync(CONFIG_FILE)) {
            const data = readFileSync(CONFIG_FILE, "utf-8");
            const parsed = JSON.parse(data) as TelemetryConfig;
            // Mark as not first run for subsequent sessions
            config = { ...parsed, isFirstRun: false };
            isFirstRunSession = false;
            return config;
        }
    } catch {
        // Config file corrupted or unreadable, create new one
    }

    // Create new installation
    const newConfig: TelemetryConfig = {
        installationId: randomUUID(),
        firstRunTimestamp: Date.now(),
        isFirstRun: true
    };

    try {
        if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));

        // Re-read to handle race condition with concurrent sessions
        // The file on disk is the source of truth
        try {
            const data = readFileSync(CONFIG_FILE, "utf-8");
            const persistedConfig = JSON.parse(data) as TelemetryConfig;
            config = persistedConfig;
            isFirstRunSession = persistedConfig.isFirstRun;
            return config;
        } catch {
            // If re-read fails, use the config we created
            config = newConfig;
            isFirstRunSession = true;
            return config;
        }
    } catch {
        // Failed to save config, continue with in-memory config
        config = newConfig;
        isFirstRunSession = true;
        return config;
    }
}

export function getInstallationId(): string {
    return loadOrCreateConfig().installationId;
}

function isFirstRun(): boolean {
    loadOrCreateConfig();
    return isFirstRunSession;
}

// ============================================================================
// Telemetry Control
// ============================================================================

export function initTelemetry(): void {
    // Check environment variable for opt-out
    const envValue = process.env.RN_DEBUGGER_TELEMETRY;
    if (envValue === "false" || envValue === "0" || envValue === "off") {
        telemetryEnabled = false;
        console.error("[rn-ai-debugger] Telemetry disabled via RN_DEBUGGER_TELEMETRY");
        return;
    }

    // Check if dev mode is enabled in config (for local development)
    const cfg = loadOrCreateConfig();
    if (cfg.devMode) {
        telemetryEnabled = false;
        return;
    }

    // Check if endpoint is configured (placeholder detection)
    if (TELEMETRY_ENDPOINT.includes("YOUR_SUBDOMAIN") || TELEMETRY_API_KEY.includes("YOUR_API_KEY")) {
        telemetryEnabled = false;
        // Silently disable - endpoint not configured yet
        return;
    }

    // Load/create config (generates installation ID)
    loadOrCreateConfig();
    sessionId = randomUUID();

    // Track that an AI agent session loaded our MCP server (regardless of tool usage)
    trackEvent("session_start", {
        isFirstRun: isFirstRun()
    });

    // Track session end on SIGINT/SIGTERM. Each event is dispatched immediately
    // with keepalive, so no flush is needed — the OS completes the request even
    // if the process exits right after.
    const handleExit = () => {
        if (sessionStarted && sessionStartTime) {
            trackEvent("session_end", {
                duration: Date.now() - sessionStartTime
            });
        }
        process.exit(0);
    };

    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);
}

export function isTelemetryEnabled(): boolean {
    return telemetryEnabled;
}

/** Check if the MCP server is running in dev mode (config-based). */
export function isDevMode(): boolean {
    try {
        const cfg = loadOrCreateConfig();
        return cfg.devMode === true;
    } catch {
        return false;
    }
}

// ============================================================================
// Event Tracking
// ============================================================================

function trackEvent(name: string, properties?: Record<string, string | number | boolean>): void {
    if (!telemetryEnabled) return;

    dispatch({
        name,
        timestamp: Date.now(),
        isFirstRun: isFirstRun(),
        properties
    });
}

export function trackToolInvocation(
    toolName: string,
    success: boolean,
    durationMs: number,
    errorMessage?: string,
    errorContext?: string,
    inputTokens?: number,
    outputTokens?: number,
    targetPlatform?: string,
    emptyResult?: boolean,
    meaningful?: boolean,
    changeRate?: number,
    tapStrategy?: string,
    iosDriver?: string,
    responsePreview?: string,
    emptyReason?: string
): void {
    // Append to local JSONL file for local dashboard (dev mode only)
    if (isDevMode()) try {
        const localEvent: Record<string, unknown> = {
            name: "tool_invocation",
            timestamp: Date.now(),
            toolName,
            success,
            duration: durationMs,
            isFirstRun: false,
        };
        if (!success && errorMessage) {
            localEvent.errorCategory = categorizeError(errorMessage, errorContext);
            localEvent.errorMessage = errorMessage.substring(0, 200);
            if (errorContext) localEvent.errorContext = errorContext.substring(0, 150);
        }
        if (targetPlatform) localEvent.targetPlatform = targetPlatform;
        if (emptyResult !== undefined) localEvent.emptyResult = emptyResult;
        if (meaningful !== undefined) localEvent.meaningful = meaningful;
        if (changeRate !== undefined) localEvent.changeRate = changeRate;
        if (tapStrategy) localEvent.tapStrategy = tapStrategy;
        if (iosDriver) localEvent.iosDriver = iosDriver;
        if (emptyReason) localEvent.emptyReason = emptyReason;
        if (responsePreview) localEvent.responsePreview = responsePreview;
        appendFileSync(TELEMETRY_JSONL_PATH, JSON.stringify(localEvent) + "\n");
    } catch {
        // Non-critical — local file sink failure should never affect tool execution
    }

    if (!telemetryEnabled) return;

    const now = Date.now();

    // Start a new session on first tool use or after inactivity gap
    if (!sessionStarted || (lastToolTimestamp && (now - lastToolTimestamp) > SESSION_INACTIVITY_MS)) {
        if (sessionStarted) {
            // End previous session before starting a new one
            trackEvent("session_end", {
                duration: lastToolTimestamp! - sessionStartTime!
            });
            sessionId = randomUUID();
        }
        sessionStarted = true;
        sessionStartTime = now;
        trackEvent("session_start_ai_devtools", {
            isFirstRun: isFirstRun(),
            firstTool: toolName
        });

        // Re-emit app_detected for any already-connected RN apps so the dashboard's
        // period-scoped platform classification keeps working on long-lived sessions.
        // Uses cached detection; no CDP round-trip.
        for (const app of connectedApps.values()) {
            if (app.appDetection) trackAppDetection(app.appDetection);
        }

        // Lazy license check — runs once per session, tracked as tool_invocation for analytics
        ensureLicense().then(({ source, status, durationMs }) => {
            trackLicenseCheck(source, status.tier, durationMs);
        }).catch(() => {
            // License check failed — not critical, don't break tool flow
        });
    }
    lastToolTimestamp = now;

    const event: TelemetryEvent = {
        name: "tool_invocation",
        timestamp: now,
        toolName,
        success,
        duration: durationMs,
        isFirstRun: isFirstRun()
    };

    if (!success && errorMessage) {
        event.errorCategory = categorizeError(errorMessage, errorContext);
        event.errorMessage = errorMessage.substring(0, 200);
        // Store truncated context (e.g., the expression that caused a syntax error)
        if (errorContext) {
            event.errorContext = errorContext.substring(0, 150);
        }
    }

    if (inputTokens !== undefined && inputTokens > 0) event.inputTokens = inputTokens;
    if (outputTokens !== undefined && outputTokens > 0) event.outputTokens = outputTokens;
    if (targetPlatform) event.targetPlatform = targetPlatform;
    if (emptyResult !== undefined) event.emptyResult = emptyResult;
    if (meaningful !== undefined) event.meaningful = meaningful;
    if (changeRate !== undefined) event.changeRate = changeRate;
    if (tapStrategy) event.tapStrategy = tapStrategy;
    if (iosDriver) event.iosDriver = iosDriver;
    if (emptyReason) event.emptyReason = emptyReason;

    dispatch(event);

    // Increment local usage counter
    incrementLocalUsage();

    // Mirror platform-cohort signal to PostHog for native users.
    // Mirrors the infra's native-user inference (backend/worker.ts:deriveNativePlatform)
    // so PostHog cohort filters match the Cloudflare dashboard.
    mirrorNativeCohortToPostHog(toolName);
}

// Track what we've already sent to PostHog so we don't re-identify on every tool call.
let _nativeKindSet = false;
let _lastNativePlatformSent: "ios" | "android" | null = null;

function mirrorNativeCohortToPostHog(toolName: string): void {
    const platform: "ios" | "android" | null = toolName.startsWith("ios_")
        ? "ios"
        : toolName.startsWith("android_")
            ? "android"
            : null;
    if (!platform) return;

    // Skip when nothing new to send
    if (_nativeKindSet && _lastNativePlatformSent === platform) return;

    try {
        const client = getPostHogClient();
        if (!client) return;

        const distinctId = getInstallationId();
        const set: Record<string, unknown> = {};
        const setOnce: Record<string, unknown> = {};

        if (!_nativeKindSet) {
            // $set_once: RN users keep platform_kind="rn" (set by trackAppDetection);
            // native-only users get "native" the first time a platform-prefixed tool fires.
            setOnce.platform_kind = "native";
            _nativeKindSet = true;
        }
        if (_lastNativePlatformSent !== platform) {
            set.platform_last_seen = platform;
            _lastNativePlatformSent = platform;
        }

        client.identify({
            distinctId,
            properties: {
                ...(Object.keys(set).length > 0 ? { $set: set } : {}),
                ...(Object.keys(setOnce).length > 0 ? { $set_once: setOnce } : {}),
            },
        });
    } catch {
        // PostHog errors must never affect tool flow.
    }
}

/**
 * Records _license_check as a tool_invocation event without triggering session logic.
 * Called from the ensureLicense() callback inside trackToolInvocation.
 */
function trackLicenseCheck(source: string, tier: string, durationMs: number): void {
    if (!telemetryEnabled) return;

    dispatch({
        name: "tool_invocation",
        timestamp: Date.now(),
        toolName: "_license_check",
        success: true,
        duration: durationMs,
        isFirstRun: isFirstRun(),
        errorContext: `${source}:${tier}`
    });
}

/**
 * Records app detection result as an app_detected event.
 * Called from appDetection.ts after successful detection.
 */
export function trackAppDetection(detection: {
    reactNativeVersion: string;
    architecture: string;
    jsEngine: string;
    appPlatform: string;
    osVersion: string;
    expoSdkVersion?: string;
}): void {
    if (!telemetryEnabled) return;

    dispatch({
        name: "app_detected",
        timestamp: Date.now(),
        isFirstRun: isFirstRun(),
        errorContext: JSON.stringify({
            rn: detection.reactNativeVersion,
            arch: detection.architecture,
            eng: detection.jsEngine,
            plat: detection.appPlatform,
            os: detection.osVersion,
            ...(detection.expoSdkVersion ? { expo: detection.expoSdkVersion } : {}),
        }),
        targetPlatform: detection.appPlatform,
    });

    // Mirror to PostHog so insights/cohort filters can use kind + platform without custom queries.
    try {
        const client = getPostHogClient();
        if (client) {
            const distinctId = getInstallationId();
            client.capture({
                distinctId,
                event: "app_detected",
                properties: {
                    rn_version: detection.reactNativeVersion,
                    architecture: detection.architecture,
                    js_engine: detection.jsEngine,
                    platform: detection.appPlatform,
                    os_version: detection.osVersion,
                    ...(detection.expoSdkVersion ? { expo_sdk: detection.expoSdkVersion } : {}),
                    platform_kind: "rn",
                    server_version: getServerVersion(),
                    package_name: getPackageName(),
                },
            });
            // Person properties so cohort filters work natively in PostHog insights.
            client.identify({
                distinctId,
                properties: {
                    $set: {
                        platform_kind: "rn",
                        platform_last_seen: detection.appPlatform,
                        rn_version: detection.reactNativeVersion,
                        architecture: detection.architecture,
                    },
                },
            });
        }
    } catch {
        // PostHog errors must never affect tool flow.
    }
}

// ============================================================================
// Event Dispatch
// ============================================================================

// One event per HTTP request, fired immediately. `keepalive: true` (undici,
// Node 18+) tells the runtime to complete the request even if the process
// exits right after — the Node equivalent of navigator.sendBeacon. No queue,
// no flush timer, no data loss on abrupt exit.
function dispatch(event: TelemetryEvent): void {
    const payload: TelemetryPayload = {
        installationId: getInstallationId(),
        sessionId: sessionId || undefined,
        serverVersion: getServerVersion(),
        packageName: getPackageName(),
        nodeVersion: process.version,
        platform: process.platform,
        events: [event]
    };

    fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": TELEMETRY_API_KEY
        },
        body: JSON.stringify(payload),
        keepalive: true,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
        // Silent: telemetry must never impact the user.
    });
}
