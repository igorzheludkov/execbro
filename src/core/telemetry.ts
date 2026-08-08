import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ensureLicense, incrementLocalUsage } from "./license.js";
import { connectedApps } from "./state.js";
import { getPostHogClient } from "./posthog.js";
import { CONFIG_DIR } from "./paths.js";
import { API_BASE_URL, ACCOUNTS_API_KEY } from "./config.js";
import { BUILD_TOKEN } from "./buildInfo.js";

// ============================================================================
// Configuration
// ============================================================================

const TELEMETRY_ENDPOINT = "https://rn-debugger-telemetry.500griven.workers.dev";
const TELEMETRY_API_KEY = "6a630181cb391ed5c42a188428cc2d2623dfe9333ec048193bb711ab58afe85e";

// The build token lives in ./buildInfo.js — a single small injector target,
// shared with the transport gate in index.ts.

export function getTelemetryEndpoint(): string { return TELEMETRY_ENDPOINT; }
export function getTelemetryApiKey(): string { return TELEMETRY_API_KEY; }
export function getMeteringEndpoint(): string { return `${API_BASE_URL}/api/usage/report`; }

const REQUEST_TIMEOUT_MS = 5_000;
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

type ErrorCategory = 'network' | 'timeout' | 'validation' | 'execution' | 'connection' | 'driver_missing' | 'screen_changed' | 'unknown';

/**
 * How a failure reached telemetry. Both paths set success=false and converge on
 * the same trackToolInvocation call, so without this the two are indistinguishable
 * downstream — the gap that made the 30d error analysis report a 203–2,516 range
 * instead of a number (docs/telemetry/error-tracking-value-analysis.md, Q4).
 *
 * - 'returned' — the handler returned { isError: true }. Handled, no exception,
 *   no stack trace, never sent to captureException.
 * - 'thrown'   — the handler threw. Real exception with a stack, and the only
 *   kind forwarded to PostHog error tracking (UserInputError excepted).
 *
 * Only 'thrown' failures can benefit from stack traces, so this is the field that
 * makes "how many real crashes do we have" answerable.
 */
type ErrorOrigin = 'thrown' | 'returned';

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
    errorOrigin?: ErrorOrigin; // How the failure reached telemetry — see ErrorOrigin
    inputTokens?: number;
    outputTokens?: number;
    targetPlatform?: string;
    emptyResult?: boolean;
    meaningful?: boolean; // tap verification: did the tap cause visual change?
    changeRate?: number; // tap verification: percentage of pixels changed (0-1)
    tapStrategy?: string; // tap: winning strategy (fiber, ocr, accessibility, coordinate, etc.)
    iosDriver?: string; // tap: which iOS UI driver was used (idb, axe)
    emptyReason?: string; // get_logs: why the result was empty — see EmptyLogReason in core/logDiagnosis.ts
    artifactKey?: string; // tap: R2 key prefix `<YYYY-MM-DD>/<uuid>` for the failure artifact bundle
    ocrClosestMatch?: string; // tap: OCR's closest fuzzy hit `"text"@score`
    fiberPressableCount?: string; // tap: count of visible pressables fiber found
    accessibilityMatchCount?: string; // tap: count of accessibility elements found
    appRoute?: string; // tap: best-effort screen identifier (route name or bundle id)
    properties?: Record<string, string | number | boolean>;
}

// ============================================================================
// Error Categorization
// ============================================================================

export function categorizeError(errorMessage: string, errorContext?: string): ErrorCategory {
    const lower = errorMessage.toLowerCase();
    // UI driver not installed — must be checked before 'validation' which matches 'missing'/'install'.
    // Covers iOS (idb/axe) and Android (adb): on Android, ADB plays the same role as a UI driver
    // (required for accessibility enumeration, screenshots, and input). Treating it identically keeps
    // the "driver_missing" bucket platform-agnostic and prevents these from polluting tap-tool error rates.
    if (lower.includes('not installed') && (lower.includes('idb') || lower.includes('axe') || lower.includes('ui driver') || lower.includes('adb'))) {
        return 'driver_missing';
    }
    // Strategy chain may contain driver-missing signals even when the primary error
    // message doesn't (e.g., strategies skipped due to missing driver, last-resort
    // strategy fails with "No element found" or "timed out")
    if (errorContext) {
        const ctxLower = errorContext.toLowerCase();
        if (ctxLower.includes('ios ui driver is not instal') || ctxLower.includes('idb is not instal') || ctxLower.includes('adb is not installed') || ctxLower.includes('adb is not in path')) {
            return 'driver_missing';
        }
    }
    // The screen moved under the agent — someone was using the app in parallel,
    // so the target genuinely was not there to hit. An explicit self-tag, never
    // inferred from prose, emitted by core/screenStaleness.ts. Deliberately
    // ranked below driver_missing (a missing driver is the realer cause when
    // both appear) and above everything else, because otherwise these land in
    // 'validation' and inflate the failure rate of a tool that did nothing
    // wrong — the same reasoning that gave driver_missing its own bucket.
    if (errorContext?.includes('screen_changed:')) {
        return 'screen_changed';
    }
    // Genuine JS runtime faults — the only signal that means "something actually
    // broke at runtime". Checked before 'network' because that rule matches the
    // bare substring 'fetch', which would swallow "TypeError: fetch is not a
    // function", and before the Hermes guards below so a real fault inside an
    // evaluated expression is not mistaken for an unsupported-syntax rejection.
    if (lower.includes('typeerror') || lower.includes('referenceerror') || lower.includes('rangeerror') ||
        lower.includes('is not a function') || lower.includes('is not defined') ||
        lower.includes('cannot read propert') || lower.includes('maximum call stack') ||
        lower.includes('is not an object')) {
        return 'execution';
    }
    if (lower.includes('websocket') || lower.includes('econnrefused') || lower.includes('socket') || lower.includes('fetch')) {
        return 'network';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
        return 'timeout';
    }
    // Hermes eval guards. These reject an unsupported expression before anything
    // runs, so they are agent-input mistakes, not runtime faults — but they say
    // "Hermes Runtime.evaluate", which the generic execution rule below matches.
    // In the 30d window ending 2026-08-01 that misfire was the *entire* contents
    // of the execution category (203 events), hiding real faults in 'unknown'.
    if (lower.includes('hermes') && (lower.includes('not supported') || lower.includes('not available'))) {
        return 'validation';
    }
    // Check connection errors before validation (since "no debuggable devices found" contains "no")
    if (lower.includes('no apps connected') || lower.includes('scan_metro') || lower.includes('not connected') ||
        lower.includes('no debuggable devices') || lower.includes('no metro server') || lower.includes('connection failed')) {
        return 'connection';
    }
    // App-state / environment problems: the tooling is fine, the app or device
    // is not in a usable state. Grouped with 'connection' rather than earning a
    // new category so the existing dashboard blob6 mapping stays valid.
    // 'devtools hook' rather than 'react devtools hook': the injected-path error
    // is the bare "no devtools hook", which the longer literal missed — those
    // events sat in 'unknown' alongside the agent-input guards below.
    if (lower.includes('devtools hook') || lower.includes('no android device connected') ||
        lower.includes('no ios device connected') || lower.includes('app is not available')) {
        return 'connection';
    }
    // A native helper ran and failed (as opposed to being absent — driver_missing
    // above already claimed that case). Real execution faults, and the ones most
    // likely to be environment-specific and unreproducible locally.
    if (lower.includes('command failed:')) {
        return 'execution';
    }
    // Syntax/compilation errors in JS code
    if (lower.includes('compiling js failed') || lower.includes('syntaxerror')) {
        return 'validation';
    }
    // Agent-input and UI-state guards: the tool refused before doing anything
    // because the request did not describe a reachable target. Placed after the
    // connection checks so "No connected device matches …" only lands here when
    // devices *are* connected and the name simply did not match — when nothing
    // is connected the message carries the scan_metro hint and is a connection
    // problem instead.
    // input_text's targeting guards belong here too. The tool refused before
    // writing anything and returned the fields that ARE on screen, so the next
    // call can name one — a two-step protocol, not a fault. Left uncategorised
    // they were 29 of 35 input_text failures on 2.6.1, which hid the real ones.
    if (lower.includes('no focused textinput') || lower.includes('must provide at least one') ||
        lower.includes('not visible on screen') || lower.includes('no component found') ||
        lower.includes('no connected device matches') || lower.includes('redux-shaped store') ||
        lower.includes('matched that target') || lower.includes('match this target') ||
        lower.includes('is out of range') || lower.includes('no textinput found on screen')) {
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
    _comment?: string;
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
    buildToken: string;
    nodeVersion: string;
    platform: string;
    events: TelemetryEvent[];
}

// ============================================================================
// State
// ============================================================================

let telemetryEnabled = true;
// Metering heartbeat: the counted tool_invocation signal required to run the
// free tier. Stays on under the analytics opt-out; only disabled in dev/unconfigured.
let meteringEnabled = true;
export function isMeteringEnabled(): boolean {
    return meteringEnabled;
}
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
        _comment: "machine-managed by execbro — do not edit",
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

/**
 * Pure decision function for the analytics/metering split. Kept side-effect
 * free so it can be unit-tested without touching env vars, disk config, or
 * the network.
 *
 * Rules:
 * - Unconfigured endpoint or dev mode: both off (no telemetry of any kind
 *   should leave a dev/unconfigured install).
 * - Env opt-out (EXECBRO_TELEMETRY=false|0|off): analytics off, but metering
 *   stays on — the free-tier cap requires the counted signal regardless of
 *   the user's analytics preference.
 * - Otherwise: both on.
 */
export function resolveTelemetryModes(opts: {
    envOptOut: boolean;
    devMode: boolean;
    endpointConfigured: boolean;
}): { telemetryEnabled: boolean; meteringEnabled: boolean } {
    if (!opts.endpointConfigured || opts.devMode) {
        return { telemetryEnabled: false, meteringEnabled: false };
    }
    if (opts.envOptOut) {
        return { telemetryEnabled: false, meteringEnabled: true };
    }
    return { telemetryEnabled: true, meteringEnabled: true };
}

export function initTelemetry(): void {
    // Check environment variable for opt-out
    const envValue = process.env.EXECBRO_TELEMETRY ?? process.env.RN_DEBUGGER_TELEMETRY;
    const envOptOut = envValue === "false" || envValue === "0" || envValue === "off";

    // Check if dev mode is enabled in config (for local development)
    const cfg = loadOrCreateConfig();

    // Check if endpoint is configured (placeholder detection)
    const endpointConfigured =
        !TELEMETRY_ENDPOINT.includes("YOUR_SUBDOMAIN") && !TELEMETRY_API_KEY.includes("YOUR_API_KEY");

    const modes = resolveTelemetryModes({ envOptOut, devMode: !!cfg.devMode, endpointConfigured });
    telemetryEnabled = modes.telemetryEnabled;
    meteringEnabled = modes.meteringEnabled;

    if (!meteringEnabled) {
        // Dev mode or unconfigured endpoint — no telemetry of any kind.
        return;
    }

    if (envOptOut) {
        console.error(
            "[execbro] Product analytics disabled via EXECBRO_TELEMETRY. Usage metering (required for the free tier) remains active.",
        );
    }

    // Load/create config (generates installation ID) — needed for metering
    // dispatch even when analytics is opted out.
    loadOrCreateConfig();
    sessionId = randomUUID();

    if (telemetryEnabled) {
        // Track that an AI agent session loaded our MCP server (regardless of tool usage)
        trackEvent("session_start", {
            isFirstRun: isFirstRun()
        });
    }

    // Track session end on SIGINT/SIGTERM. Each event is dispatched immediately
    // with keepalive, so no flush is needed — the OS completes the request even
    // if the process exits right after.
    const handleExit = () => {
        if (telemetryEnabled && sessionStarted && sessionStartTime) {
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
    emptyReason?: string,
    artifactKey?: string,
    ocrClosestMatch?: string,
    fiberPressableCount?: string,
    accessibilityMatchCount?: string,
    appRoute?: string,
    errorOrigin?: ErrorOrigin
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
            if (errorOrigin) localEvent.errorOrigin = errorOrigin;
        }
        // Always propagate errorContext when provided — unmeaningful taps are success=true
        // but still carry triage context (predicate, strategy chain) that must reach blob8.
        if (errorContext) localEvent.errorContext = errorContext.substring(0, 150);
        if (targetPlatform) localEvent.targetPlatform = targetPlatform;
        if (emptyResult !== undefined) localEvent.emptyResult = emptyResult;
        if (meaningful !== undefined) localEvent.meaningful = meaningful;
        if (changeRate !== undefined) localEvent.changeRate = changeRate;
        if (tapStrategy) localEvent.tapStrategy = tapStrategy;
        if (iosDriver) localEvent.iosDriver = iosDriver;
        if (emptyReason) localEvent.emptyReason = emptyReason;
        if (responsePreview) localEvent.responsePreview = responsePreview;
        if (artifactKey) localEvent.artifactKey = artifactKey;
        if (ocrClosestMatch) localEvent.ocrClosestMatch = ocrClosestMatch;
        if (fiberPressableCount) localEvent.fiberPressableCount = fiberPressableCount;
        if (accessibilityMatchCount) localEvent.accessibilityMatchCount = accessibilityMatchCount;
        if (appRoute) localEvent.appRoute = appRoute;
        appendFileSync(TELEMETRY_JSONL_PATH, JSON.stringify(localEvent) + "\n");
    } catch {
        // Non-critical — local file sink failure should never affect tool execution
    }

    // Metering (the counted dispatch below) fires whenever meteringEnabled is
    // true, even if the user opted out of analytics via EXECBRO_TELEMETRY.
    // Only bail out entirely when both are off (dev mode / unconfigured
    // endpoint) — nothing downstream has anything to do in that case.
    if (!meteringEnabled && !telemetryEnabled) return;

    const now = Date.now();

    // Start a new session on first tool use or after inactivity gap. This is
    // analytics bookkeeping only — trackEvent/trackAppDetection/trackLicenseCheck
    // each internally no-op when telemetryEnabled is false, so this block has
    // no effect on opted-out users beyond harmless local state updates.
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
        if (errorOrigin) event.errorOrigin = errorOrigin;
    }
    // Always propagate errorContext when provided — unmeaningful taps are success=true
    // but still carry triage context (predicate, strategy chain) that must reach blob8.
    if (errorContext) {
        event.errorContext = errorContext.substring(0, 150);
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
    if (artifactKey) event.artifactKey = artifactKey;
    if (ocrClosestMatch) event.ocrClosestMatch = ocrClosestMatch;
    if (fiberPressableCount) event.fiberPressableCount = fiberPressableCount;
    if (accessibilityMatchCount) event.accessibilityMatchCount = accessibilityMatchCount;
    if (appRoute) event.appRoute = appRoute;

    // Counted signal: this is the metering heartbeat the free-tier cap relies
    // on. Fires whenever meteringEnabled — including when the user opted out
    // of analytics — so opting out of PostHog/analytics can never freeze
    // (bypass) the usage count.
    if (meteringEnabled) {
        dispatchMetering(event);
    }

    if (telemetryEnabled) {
        // Mirror tool_invocation to PostHog so insights/cohort filters can count
        // per-tool usage natively. Cloudflare remains the source of truth; PostHog
        // gets a parallel stream keyed on the same installation id.
        try {
            const client = getPostHogClient();
            if (client) {
                const phProps: Record<string, unknown> = {
                    tool_name: toolName,
                    success,
                    duration_ms: durationMs,
                    is_first_run: isFirstRun(),
                    server_version: getServerVersion(),
                    package_name: getPackageName(),
                    session_id: sessionId?.substring(0, 12) ?? "",
                };
                if (event.errorCategory) phProps.error_category = event.errorCategory;
                if (event.errorMessage) phProps.error_message = event.errorMessage;
                if (event.errorContext) phProps.error_context = event.errorContext;
                if (event.errorOrigin) phProps.error_origin = event.errorOrigin;
                if (targetPlatform) phProps.target_platform = targetPlatform;
                if (emptyResult !== undefined) phProps.empty_result = emptyResult;
                if (meaningful !== undefined) phProps.meaningful = meaningful;
                if (changeRate !== undefined) phProps.change_rate = changeRate;
                if (tapStrategy) phProps.tap_strategy = tapStrategy;
                if (iosDriver) phProps.ios_driver = iosDriver;
                if (emptyReason) phProps.empty_reason = emptyReason;
                if (inputTokens !== undefined && inputTokens > 0) phProps.input_tokens = inputTokens;
                if (outputTokens !== undefined && outputTokens > 0) phProps.output_tokens = outputTokens;

                client.capture({
                    distinctId: getInstallationId(),
                    event: "tool_invocation",
                    properties: phProps,
                });
            }
        } catch {
            // PostHog errors must never affect tool flow.
        }
    }

    // Increment local usage counter — powers the live 80% warning, so it must
    // run whenever the counted dispatch runs, regardless of analytics opt-out.
    if (meteringEnabled) {
        incrementLocalUsage();
    }

    if (telemetryEnabled) {
        // Mirror platform-cohort signal to PostHog for native users.
        // Mirrors the infra's native-user inference (backend/worker.ts:deriveNativePlatform)
        // so PostHog cohort filters match the Cloudflare dashboard.
        mirrorNativeCohortToPostHog(toolName);
    }
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

export type AutoReconnectOutcome = "not_needed" | "success" | "scan_failed" | "retry_failed";

/**
 * Record auto-reconnect outcome for the CDP wrapper.
 *
 * Emits as a 'tool_invocation' row (so existing dashboards count it) with a
 * synthetic toolName '_auto_reconnect' and `errorContext` carrying the
 * outcome + originating toolName + transportPattern. Does not start a session
 * or affect license counting.
 */
export function trackAutoReconnect(
    outcome: AutoReconnectOutcome,
    originatingToolName: string,
    transportPattern?: string,
): void {
    if (!telemetryEnabled) return;
    // No-op outcomes ('not_needed') account for ~98% of events and carry zero
    // signal — only emit when the wrapper actually attempted a reconnect.
    if (outcome === "not_needed") return;
    // Skip events fired before a session_id is assigned (e.g. first
    // executeInApp before session_start) — they're un-attributable.
    if (!sessionId) return;

    dispatch({
        name: "tool_invocation",
        timestamp: Date.now(),
        toolName: "_auto_reconnect",
        success: outcome === "success",
        duration: 0,
        isFirstRun: isFirstRun(),
        errorContext: JSON.stringify({
            outcome,
            tool: originatingToolName,
            ...(transportPattern ? { pattern: transportPattern } : {}),
        }),
    });

    try {
        const client = getPostHogClient();
        if (client) {
            client.capture({
                distinctId: getInstallationId(),
                event: "transport_auto_reconnect",
                properties: {
                    outcome,
                    tool_name: originatingToolName,
                    transport_pattern: transportPattern,
                    server_version: getServerVersion(),
                    package_name: getPackageName(),
                    session_id: sessionId?.substring(0, 12) ?? "",
                },
            });
        }
    } catch {
        // PostHog errors must never affect tool flow.
    }
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

/**
 * Records a Fast Refresh recorder install event. Fired once per
 * device-session by getRefreshStatus when the executor lazy-installs the
 * recorder or detects an install failure. SDK-side installs (which happen
 * before the executor sees the app) surface here as via != null with
 * justInstalled = false on the first observation.
 */
export function trackFastRefreshInstall(detection: {
    via: "performReactRefresh" | "RefreshReg" | null;
    recorderInstalled: boolean;
    justInstalled: boolean;
    reason?: string;
}): void {
    if (!telemetryEnabled) return;

    dispatch({
        name: "fast_refresh_install",
        timestamp: Date.now(),
        isFirstRun: isFirstRun(),
        errorContext: JSON.stringify({
            via: detection.via,
            installed: detection.recorderInstalled,
            just: detection.justInstalled,
            ...(detection.reason ? { reason: detection.reason } : {}),
        }),
    });
}

// ============================================================================
// Event Dispatch
// ============================================================================

// One event per HTTP request, fired immediately. `keepalive: true` (undici,
// Node 18+) tells the runtime to complete the request even if the process
// exits right after — the Node equivalent of navigator.sendBeacon. No queue,
// no flush timer, no data loss on abrupt exit.
function buildPayload(event: TelemetryEvent): TelemetryPayload {
    return {
        installationId: getInstallationId(),
        sessionId: sessionId || undefined,
        serverVersion: getServerVersion(),
        packageName: getPackageName(),
        buildToken: BUILD_TOKEN,
        nodeVersion: process.version,
        platform: process.platform,
        events: [event]
    };
}

function dispatch(event: TelemetryEvent): void {
    fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": TELEMETRY_API_KEY
        },
        body: JSON.stringify(buildPayload(event)),
        keepalive: true,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
        // Silent: telemetry must never impact the user.
    });
}

// Counted metering signal. Goes to the API domain (relayed server-side to the
// same Analytics Engine dataset) so that blocking metering also blocks license
// validation — reachability of one implies countability by the other.
function dispatchMetering(event: TelemetryEvent): void {
    fetch(getMeteringEndpoint(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": ACCOUNTS_API_KEY
        },
        body: JSON.stringify(buildPayload(event)),
        keepalive: true,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
        // Silent: metering must never impact the user.
    });
}
