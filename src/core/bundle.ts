import WebSocket from "ws";

// Bundle error entry
export interface BundleError {
    timestamp: Date;
    type: "syntax" | "resolution" | "transform" | "other";
    message: string;
    file?: string;
    line?: number;
    column?: number;
    codeFrame?: string;
    importStack?: string[];
}

// Bundle status from Metro
export interface BundleStatus {
    isBuilding: boolean;
    hasError: boolean;
    buildTime?: number;
    lastBuildTimestamp?: Date;
}

// Circular buffer for bundle errors
export class BundleErrorBuffer {
    private errors: BundleError[] = [];
    private maxSize: number;
    private lastStatus: BundleStatus = { isBuilding: false, hasError: false };

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
    }

    add(error: BundleError): void {
        this.errors.push(error);
        if (this.errors.length > this.maxSize) {
            this.errors.shift();
        }
        this.lastStatus.hasError = true;
    }

    get(count?: number): BundleError[] {
        if (count && count > 0) {
            return this.errors.slice(-count);
        }
        return [...this.errors];
    }

    getLatest(): BundleError | null {
        return this.errors.length > 0 ? this.errors[this.errors.length - 1] : null;
    }

    clear(): number {
        const count = this.errors.length;
        this.errors = [];
        this.lastStatus.hasError = false;
        return count;
    }

    get size(): number {
        return this.errors.length;
    }

    getStatus(): BundleStatus {
        return { ...this.lastStatus };
    }

    updateStatus(status: Partial<BundleStatus>): void {
        this.lastStatus = { ...this.lastStatus, ...status };
    }
}

// Parse Metro error message into structured BundleError
export function parseMetroError(errorText: string): BundleError {
    const error: BundleError = {
        timestamp: new Date(),
        type: "other",
        message: errorText
    };

    // Parse "Unable to resolve" errors (module resolution)
    const resolutionMatch = errorText.match(/Unable to resolve ["']([^"']+)["'] from ["']([^"']+)["']/);
    if (resolutionMatch) {
        error.type = "resolution";
        error.message = `Unable to resolve "${resolutionMatch[1]}"`;
        error.file = resolutionMatch[2];
    }

    // Parse file path and line/column info
    const locationMatch = errorText.match(/> (\d+) \|/);
    if (locationMatch) {
        error.line = parseInt(locationMatch[1], 10);
    }

    // Look for column marker (^)
    const columnMatch = errorText.match(/\n\s*\|?\s*\^/);
    if (columnMatch) {
        const markerLine = errorText.split('\n').find(l => l.includes('^') && !l.includes('|'));
        if (markerLine) {
            error.column = markerLine.indexOf('^');
        }
    }

    // Parse import stack
    const importStackMatch = errorText.match(/Import stack:[\s\S]*$/);
    if (importStackMatch) {
        const stackText = importStackMatch[0];
        const imports = stackText.match(/\| import ["']([^"']+)["']/g);
        if (imports) {
            error.importStack = imports.map(i => {
                const m = i.match(/["']([^"']+)["']/);
                return m ? m[1] : i;
            });
        }

        // Extract file references from stack
        const fileRefs = stackText.match(/^\s*([^\s|]+\.(tsx?|jsx?))/gm);
        if (fileRefs) {
            error.importStack = fileRefs.map(f => f.trim()).filter(f => !f.startsWith('|'));
        }
    }

    // Capture code frame if present
    const codeFrameMatch = errorText.match(/(\s*\d+\s*\|[\s\S]*?\^)/);
    if (codeFrameMatch) {
        error.codeFrame = codeFrameMatch[1];
    }

    // Detect syntax errors
    if (errorText.includes('SyntaxError') || errorText.includes('Unexpected token')) {
        error.type = "syntax";
    }

    // Detect transform errors
    if (errorText.includes('TransformError') || errorText.includes('babel')) {
        error.type = "transform";
    }

    return error;
}

// Format bundle error for display
export function formatBundleError(error: BundleError): string {
    const lines: string[] = [];

    const time = error.timestamp.toLocaleTimeString();
    lines.push(`[${time}] ${error.type.toUpperCase()} ERROR`);
    lines.push(`Message: ${error.message}`);

    if (error.file) {
        let location = `File: ${error.file}`;
        if (error.line) {
            location += `:${error.line}`;
            if (error.column) {
                location += `:${error.column}`;
            }
        }
        lines.push(location);
    }

    if (error.codeFrame) {
        lines.push("\nCode:");
        lines.push(error.codeFrame);
    }

    if (error.importStack && error.importStack.length > 0) {
        lines.push("\nImport Stack:");
        error.importStack.forEach(imp => {
            lines.push(`  - ${imp}`);
        });
    }

    return lines.join("\n");
}

// Format multiple bundle errors
export function formatBundleErrors(errors: BundleError[]): string {
    if (errors.length === 0) {
        return "No bundle errors captured.";
    }

    return errors.map(formatBundleError).join("\n\n---\n\n");
}

// Metro WebSocket connection for build events
let metroEventWs: WebSocket | null = null;
let bundleErrorBuffer: BundleErrorBuffer | null = null;

// Metro build events reconnection state
let metroBuildEventPort: number | null = null;
let metroBuildEventReconnecting = false;
let metroBuildEventAttempts = 0;
const MAX_BUILD_EVENT_RECONNECT_ATTEMPTS = 5;
const BUILD_EVENT_BACKOFF_BASE_MS = 500;

// Initialize bundle error buffer (called from state.ts)
export function initBundleErrorBuffer(buffer: BundleErrorBuffer): void {
    bundleErrorBuffer = buffer;
}

/**
 * Schedule reconnection for Metro build events with exponential backoff
 */
function scheduleBuildEventReconnection(port: number): void {
    if (metroBuildEventReconnecting) return;
    if (metroBuildEventAttempts >= MAX_BUILD_EVENT_RECONNECT_ATTEMPTS) {
        console.error(`[rn-ai-debugger] Max reconnection attempts for Metro build events reached`);
        metroBuildEventReconnecting = false;
        return;
    }

    metroBuildEventReconnecting = true;
    const delay = Math.min(BUILD_EVENT_BACKOFF_BASE_MS * Math.pow(2, metroBuildEventAttempts), 8000);

    console.error(`[rn-ai-debugger] Scheduling Metro build events reconnection in ${delay}ms (attempt ${metroBuildEventAttempts + 1}/${MAX_BUILD_EVENT_RECONNECT_ATTEMPTS})`);

    setTimeout(async () => {
        metroBuildEventAttempts++;
        try {
            await connectMetroBuildEvents(port);
            // Reset on successful connection
            metroBuildEventAttempts = 0;
            metroBuildEventReconnecting = false;
        } catch {
            metroBuildEventReconnecting = false;
            if (metroBuildEventAttempts < MAX_BUILD_EVENT_RECONNECT_ATTEMPTS) {
                scheduleBuildEventReconnection(port);
            } else {
                console.error("[rn-ai-debugger] Failed to reconnect to Metro build events");
            }
        }
    }, delay);
}

// Connect to Metro's WebSocket for build events
export async function connectMetroBuildEvents(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        if (metroEventWs && metroEventWs.readyState === WebSocket.OPEN) {
            resolve("Already connected to Metro build events");
            return;
        }

        try {
            // Metro exposes build events via its main WebSocket or through /hot endpoint
            const ws = new WebSocket(`ws://localhost:${port}/hot`);

            ws.on("open", () => {
                metroEventWs = ws;
                metroBuildEventPort = port;
                // Reset reconnection state on successful connection
                metroBuildEventAttempts = 0;
                metroBuildEventReconnecting = false;
                console.error(`[rn-ai-debugger] Connected to Metro build events on port ${port}`);
                resolve(`Connected to Metro build events on port ${port}`);
            });

            ws.on("message", (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    handleMetroBuildMessage(message);
                } catch {
                    // Non-JSON message, might be an error string
                    const text = data.toString();
                    if (text.includes('error') || text.includes('Error') || text.includes('Unable to resolve')) {
                        if (bundleErrorBuffer) {
                            bundleErrorBuffer.add(parseMetroError(text));
                        }
                    }
                }
            });

            ws.on("close", () => {
                metroEventWs = null;
                console.error("[rn-ai-debugger] Disconnected from Metro build events");

                // Trigger auto-reconnection
                if (metroBuildEventPort && !metroBuildEventReconnecting) {
                    scheduleBuildEventReconnection(metroBuildEventPort);
                }
            });

            ws.on("error", (error: Error) => {
                metroEventWs = null;
                // Only reject if not a reconnection attempt
                if (!metroBuildEventReconnecting) {
                    reject(`Failed to connect to Metro build events: ${error.message}`);
                }
            });

            setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    ws.terminate();
                    reject("Connection to Metro build events timed out");
                }
            }, 5000);
        } catch (error) {
            reject(`Failed to create WebSocket connection: ${error}`);
        }
    });
}

// Handle Metro build event messages
function handleMetroBuildMessage(message: Record<string, unknown>): void {
    if (!bundleErrorBuffer) return;

    const type = message.type as string;

    // Handle bundle build start
    if (type === "bundle_build_started") {
        bundleErrorBuffer.updateStatus({
            isBuilding: true,
            hasError: false
        });
    }

    // Handle bundle build done
    if (type === "bundle_build_done" || type === "bundle_build_succeeded") {
        bundleErrorBuffer.updateStatus({
            isBuilding: false,
            lastBuildTimestamp: new Date(),
            buildTime: message.buildTime as number | undefined
        });
    }

    // Handle bundle build failed
    if (type === "bundle_build_failed" || type === "error") {
        bundleErrorBuffer.updateStatus({
            isBuilding: false,
            hasError: true
        });

        const errorMessage = (message.body as { message?: string })?.message ||
                           message.message as string ||
                           JSON.stringify(message);

        bundleErrorBuffer.add(parseMetroError(errorMessage));
    }

    // Handle HMR update errors
    if (type === "update_start") {
        bundleErrorBuffer.updateStatus({ isBuilding: true });
    }

    if (type === "update_done") {
        bundleErrorBuffer.updateStatus({
            isBuilding: false,
            lastBuildTimestamp: new Date()
        });
    }

    if (type === "update_error" || type === "error-message") {
        bundleErrorBuffer.updateStatus({
            isBuilding: false,
            hasError: true
        });

        const errorMessage = (message.body as { message?: string })?.message ||
                           message.message as string ||
                           JSON.stringify(message);

        bundleErrorBuffer.add(parseMetroError(errorMessage));
    }
}

// Fetch bundle status from Metro's /status endpoint
export async function fetchBundleStatus(port: number): Promise<BundleStatus> {
    try {
        const response = await fetch(`http://localhost:${port}/status`);
        if (!response.ok) {
            return { isBuilding: false, hasError: false };
        }
        const text = await response.text();

        // Metro returns "packager-status:running" when idle
        return {
            isBuilding: !text.includes("running"),
            hasError: false
        };
    } catch {
        return { isBuilding: false, hasError: false };
    }
}

// Get bundle errors from buffer
export function getBundleErrors(
    buffer: BundleErrorBuffer,
    options: { maxErrors?: number } = {}
): { errors: BundleError[]; formatted: string } {
    const { maxErrors = 10 } = options;
    const errors = buffer.get(maxErrors);
    return {
        errors,
        formatted: formatBundleErrors(errors)
    };
}

// Get current bundle status with any recent errors
export async function getBundleStatusWithErrors(
    buffer: BundleErrorBuffer,
    metroPort?: number
): Promise<{ status: BundleStatus; latestError: BundleError | null; formatted: string }> {
    // Try to get status from any connected Metro port
    let status = buffer.getStatus();

    // Check Metro port status if available
    if (metroPort) {
        const liveStatus = await fetchBundleStatus(metroPort);
        status = {
            ...status,
            isBuilding: liveStatus.isBuilding
        };
        buffer.updateStatus(status);
    }

    const latestError = buffer.getLatest();

    const lines: string[] = [];
    lines.push(`Bundle Status:`);
    lines.push(`  Building: ${status.isBuilding ? "Yes" : "No"}`);
    lines.push(`  Has Error: ${status.hasError ? "Yes" : "No"}`);

    if (status.lastBuildTimestamp) {
        lines.push(`  Last Build: ${status.lastBuildTimestamp.toLocaleTimeString()}`);
    }

    if (status.buildTime) {
        lines.push(`  Build Time: ${status.buildTime}ms`);
    }

    lines.push(`  Errors in Buffer: ${buffer.size}`);

    if (latestError) {
        lines.push("\nLatest Error:");
        lines.push(formatBundleError(latestError));
    }

    return {
        status,
        latestError,
        formatted: lines.join("\n")
    };
}

// Disconnect from Metro build events
export function disconnectMetroBuildEvents(): void {
    if (metroEventWs) {
        metroEventWs.close();
        metroEventWs = null;
    }
}

// Check if connected to Metro build events
export function isConnectedToMetroBuildEvents(): boolean {
    return metroEventWs !== null && metroEventWs.readyState === WebSocket.OPEN;
}
