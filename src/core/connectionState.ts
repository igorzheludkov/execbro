import {
    ConnectionState,
    ConnectionGap,
    ConnectionMetadata,
    ReconnectionConfig,
    ContextHealth,
} from "./types.js";

// Default reconnection configuration
export const DEFAULT_RECONNECTION_CONFIG: ReconnectionConfig = {
    enabled: true,
    maxAttempts: 8, // ~30 seconds total with backoff
    initialDelayMs: 500, // Small delay to prevent tight loops (was 0)
    maxDelayMs: 8000, // Cap at 8 seconds
    backoffMultiplier: 2, // Double each time: 500, 1000, 2000, 4000, 8000
};

// Minimum time a connection must be stable before resetting reconnection attempts
// This prevents tight loops when connections succeed briefly then fail
export const MIN_STABLE_CONNECTION_MS = 5000;

// Store connection metadata for reconnection attempts
const connectionMetadata: Map<string, ConnectionMetadata> = new Map();

// Store connection state (separate from the actual connection)
const connectionStates: Map<string, ConnectionState> = new Map();

// Active reconnection timers
const reconnectionTimers: Map<string, NodeJS.Timeout> = new Map();

/**
 * Initialize connection state for a new connection
 */
export function initConnectionState(appKey: string): ConnectionState {
    const state: ConnectionState = {
        status: "connected",
        lastConnectedTime: new Date(),
        lastDisconnectTime: null,
        reconnectionAttempts: 0,
        connectionGaps: [],
    };
    connectionStates.set(appKey, state);
    return state;
}

/**
 * Update connection state with partial updates
 */
export function updateConnectionState(
    appKey: string,
    updates: Partial<ConnectionState>
): void {
    const current = connectionStates.get(appKey);
    if (current) {
        connectionStates.set(appKey, { ...current, ...updates });
    }
}

/**
 * Get connection state for an appKey
 */
export function getConnectionState(appKey: string): ConnectionState | null {
    return connectionStates.get(appKey) || null;
}

/**
 * Get all connection states
 */
export function getAllConnectionStates(): Map<string, ConnectionState> {
    return new Map(connectionStates);
}

/**
 * Record the start of a connection gap
 */
export function recordConnectionGap(appKey: string, reason: string): void {
    const state = connectionStates.get(appKey);
    if (state) {
        const gap: ConnectionGap = {
            disconnectedAt: new Date(),
            reconnectedAt: null,
            durationMs: null,
            reason,
        };
        state.connectionGaps.push(gap);
        // Keep only last 10 gaps to prevent memory bloat
        if (state.connectionGaps.length > 10) {
            state.connectionGaps.shift();
        }
        connectionStates.set(appKey, state);
    }
}

/**
 * Close the most recent connection gap when reconnected
 */
export function closeConnectionGap(appKey: string): void {
    const state = connectionStates.get(appKey);
    if (state && state.connectionGaps.length > 0) {
        const lastGap = state.connectionGaps[state.connectionGaps.length - 1];
        if (!lastGap.reconnectedAt) {
            lastGap.reconnectedAt = new Date();
            lastGap.durationMs =
                lastGap.reconnectedAt.getTime() - lastGap.disconnectedAt.getTime();
        }
        connectionStates.set(appKey, state);
    }
}

/**
 * Get recent connection gaps across all connections within a time window
 */
export function getRecentGaps(maxAgeMs: number): ConnectionGap[] {
    const now = Date.now();
    const gaps: ConnectionGap[] = [];

    for (const state of connectionStates.values()) {
        for (const gap of state.connectionGaps) {
            const gapAge = now - gap.disconnectedAt.getTime();
            if (gapAge <= maxAgeMs) {
                gaps.push(gap);
            }
        }
    }

    return gaps.sort(
        (a, b) => a.disconnectedAt.getTime() - b.disconnectedAt.getTime()
    );
}

/**
 * Check if there was a recent disconnect for a specific connection
 */
export function hasRecentDisconnect(appKey: string, withinMs: number): boolean {
    const state = connectionStates.get(appKey);
    if (!state || state.connectionGaps.length === 0) {
        return false;
    }

    const lastGap = state.connectionGaps[state.connectionGaps.length - 1];
    const gapAge = Date.now() - lastGap.disconnectedAt.getTime();
    return gapAge <= withinMs;
}

/**
 * Save connection metadata for potential reconnection
 */
export function saveConnectionMetadata(
    appKey: string,
    metadata: ConnectionMetadata
): void {
    connectionMetadata.set(appKey, metadata);
}

/**
 * Get connection metadata for reconnection
 */
export function getConnectionMetadata(
    appKey: string
): ConnectionMetadata | null {
    return connectionMetadata.get(appKey) || null;
}

/**
 * Clear connection metadata (when giving up on reconnection)
 */
export function clearConnectionMetadata(appKey: string): void {
    connectionMetadata.delete(appKey);
}

/**
 * Get all connection metadata
 */
export function getAllConnectionMetadata(): Map<string, ConnectionMetadata> {
    return new Map(connectionMetadata);
}

/**
 * Save a reconnection timer
 */
export function saveReconnectionTimer(
    appKey: string,
    timer: NodeJS.Timeout
): void {
    reconnectionTimers.set(appKey, timer);
}

/**
 * Get and clear reconnection timer
 */
export function getAndClearReconnectionTimer(
    appKey: string
): NodeJS.Timeout | null {
    const timer = reconnectionTimers.get(appKey);
    if (timer) {
        reconnectionTimers.delete(appKey);
        return timer;
    }
    return null;
}

/**
 * Cancel a reconnection timer if one exists
 */
export function cancelReconnectionTimer(appKey: string): void {
    const timer = reconnectionTimers.get(appKey);
    if (timer) {
        clearTimeout(timer);
        reconnectionTimers.delete(appKey);
    }
}

/**
 * Cancel all reconnection timers
 */
export function cancelAllReconnectionTimers(): void {
    for (const [appKey, timer] of reconnectionTimers.entries()) {
        clearTimeout(timer);
        reconnectionTimers.delete(appKey);
    }
}

/**
 * Clear all connection state (for cleanup)
 */
export function clearAllConnectionState(): void {
    cancelAllReconnectionTimers();
    connectionMetadata.clear();
    connectionStates.clear();
}

/**
 * Calculate backoff delay for reconnection attempts
 */
export function calculateBackoffDelay(
    attempt: number,
    config: ReconnectionConfig = DEFAULT_RECONNECTION_CONFIG
): number {
    if (attempt === 0) return config.initialDelayMs;
    const delay =
        500 * Math.pow(config.backoffMultiplier, attempt - 1);
    return Math.min(delay, config.maxDelayMs);
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// ========== Context Health Tracking ==========

// Store context health per connection
const contextHealthStates: Map<string, ContextHealth> = new Map();

/**
 * Initialize context health for a new connection
 */
export function initContextHealth(appKey: string): ContextHealth {
    const health: ContextHealth = {
        contextId: null,
        lastContextCreated: null,
        lastContextDestroyed: null,
        isStale: false,
        lastHealthCheck: null,
        lastHealthCheckSuccess: false,
    };
    contextHealthStates.set(appKey, health);
    return health;
}

/**
 * Get context health for an appKey
 */
export function getContextHealth(appKey: string): ContextHealth | null {
    return contextHealthStates.get(appKey) || null;
}

/**
 * Update context health with partial updates
 */
export function updateContextHealth(
    appKey: string,
    updates: Partial<ContextHealth>
): void {
    const current = contextHealthStates.get(appKey);
    if (current) {
        contextHealthStates.set(appKey, { ...current, ...updates });
    }
}

/**
 * Mark context as stale (e.g., after context destruction)
 */
export function markContextStale(appKey: string): void {
    const current = contextHealthStates.get(appKey);
    if (current) {
        contextHealthStates.set(appKey, {
            ...current,
            isStale: true,
            lastContextDestroyed: new Date(),
        });
    }
}

/**
 * Mark context as healthy (e.g., after context creation)
 */
export function markContextHealthy(appKey: string, contextId: number): void {
    const current = contextHealthStates.get(appKey);
    if (current) {
        contextHealthStates.set(appKey, {
            ...current,
            contextId,
            isStale: false,
            lastContextCreated: new Date(),
        });
    } else {
        // Initialize if not exists
        const health = initContextHealth(appKey);
        health.contextId = contextId;
        health.lastContextCreated = new Date();
        contextHealthStates.set(appKey, health);
    }
}

/**
 * Clear context health for an appKey
 */
export function clearContextHealth(appKey: string): void {
    contextHealthStates.delete(appKey);
}

/**
 * Get all context health states
 */
export function getAllContextHealth(): Map<string, ContextHealth> {
    return new Map(contextHealthStates);
}
