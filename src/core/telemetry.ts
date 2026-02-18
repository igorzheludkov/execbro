import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ============================================================================
// Configuration
// ============================================================================

const TELEMETRY_ENDPOINT = "https://rn-debugger-telemetry.500griven.workers.dev";
const TELEMETRY_API_KEY = "6a630181cb391ed5c42a188428cc2d2623dfe9333ec048193bb711ab58afe85e";

const BATCH_SIZE = 10;
const BATCH_INTERVAL_MS = 30_000; // 30 seconds
const REQUEST_TIMEOUT_MS = 5_000;
const CONFIG_DIR = join(homedir(), ".rn-ai-debugger");
const CONFIG_FILE = join(CONFIG_DIR, "telemetry.json");

// Read version from package.json dynamically
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
// Types
// ============================================================================

type ErrorCategory = 'network' | 'timeout' | 'validation' | 'execution' | 'connection' | 'unknown';

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
    properties?: Record<string, string | number | boolean>;
}

// ============================================================================
// Error Categorization
// ============================================================================

function categorizeError(errorMessage: string): ErrorCategory {
    const lower = errorMessage.toLowerCase();
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
    return 'unknown';
}

interface TelemetryConfig {
    installationId: string;
    firstRunTimestamp: number;
    isFirstRun: boolean;
}

interface TelemetryPayload {
    installationId: string;
    serverVersion: string;
    nodeVersion: string;
    platform: string;
    events: TelemetryEvent[];
}

// ============================================================================
// State
// ============================================================================

let telemetryEnabled = true;
let config: TelemetryConfig | null = null;
let eventQueue: TelemetryEvent[] = [];
let batchTimer: NodeJS.Timeout | null = null;
let sessionStartTime: number | null = null;
let isFirstRunSession = false;

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

function getInstallationId(): string {
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

    // Check if endpoint is configured (placeholder detection)
    if (TELEMETRY_ENDPOINT.includes("YOUR_SUBDOMAIN") || TELEMETRY_API_KEY.includes("YOUR_API_KEY")) {
        telemetryEnabled = false;
        // Silently disable - endpoint not configured yet
        return;
    }

    // Load/create config (generates installation ID)
    loadOrCreateConfig();
    sessionStartTime = Date.now();

    // Track session start
    trackEvent("session_start", {
        isFirstRun: isFirstRun()
    });

    // Start batch timer
    startBatchTimer();

    // Flush on process exit
    process.on("beforeExit", () => {
        flushSync();
    });

    // Track session end on SIGINT/SIGTERM
    const handleExit = () => {
        if (sessionStartTime) {
            trackEvent("session_end", {
                duration: Date.now() - sessionStartTime
            });
            flushSync();
        }
        process.exit(0);
    };

    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);
}

export function isTelemetryEnabled(): boolean {
    return telemetryEnabled;
}

// ============================================================================
// Event Tracking
// ============================================================================

function trackEvent(name: string, properties?: Record<string, string | number | boolean>): void {
    if (!telemetryEnabled) return;

    const event: TelemetryEvent = {
        name,
        timestamp: Date.now(),
        isFirstRun: isFirstRun(),
        properties
    };

    eventQueue.push(event);

    // Flush immediately if batch size reached
    if (eventQueue.length >= BATCH_SIZE) {
        flush();
    }
}

export function trackToolInvocation(
    toolName: string,
    success: boolean,
    durationMs: number,
    errorMessage?: string,
    errorContext?: string,
    inputTokens?: number,
    outputTokens?: number
): void {
    if (!telemetryEnabled) return;

    const event: TelemetryEvent = {
        name: "tool_invocation",
        timestamp: Date.now(),
        toolName,
        success,
        duration: durationMs,
        isFirstRun: isFirstRun()
    };

    if (!success && errorMessage) {
        event.errorCategory = categorizeError(errorMessage);
        event.errorMessage = errorMessage.substring(0, 200);
        // Store truncated context (e.g., the expression that caused a syntax error)
        if (errorContext) {
            event.errorContext = errorContext.substring(0, 150);
        }
    }

    if (inputTokens !== undefined && inputTokens > 0) event.inputTokens = inputTokens;
    if (outputTokens !== undefined && outputTokens > 0) event.outputTokens = outputTokens;

    eventQueue.push(event);

    if (eventQueue.length >= BATCH_SIZE) {
        flush();
    }
}

// ============================================================================
// Batch Sending
// ============================================================================

function startBatchTimer(): void {
    if (batchTimer) return;

    batchTimer = setInterval(() => {
        flush();
    }, BATCH_INTERVAL_MS);

    // Unref so it doesn't keep the process alive
    batchTimer.unref();
}

async function flush(): Promise<void> {
    if (!telemetryEnabled || eventQueue.length === 0) return;

    const eventsToSend = [...eventQueue];
    eventQueue = [];

    try {
        await sendEvents(eventsToSend);
    } catch {
        // Silently fail - telemetry should never impact the user
    }
}

function flushSync(): void {
    if (!telemetryEnabled || eventQueue.length === 0) return;

    const eventsToSend = [...eventQueue];
    eventQueue = [];

    // Use a synchronous-ish approach for exit handlers
    // This won't actually wait, but queues the request
    sendEvents(eventsToSend).catch(() => {});
}

async function sendEvents(events: TelemetryEvent[]): Promise<void> {
    const payload: TelemetryPayload = {
        installationId: getInstallationId(),
        serverVersion: getServerVersion(),
        nodeVersion: process.version,
        platform: process.platform,
        events
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        await fetch(TELEMETRY_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": TELEMETRY_API_KEY
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
}
