/**
 * Cloudflare Worker for React Native AI Debugger Telemetry
 *
 * Receives anonymous usage telemetry from the MCP server and stores in Analytics Engine.
 * Protected by API key and rate limiting.
 */

interface Env {
    TELEMETRY: AnalyticsEngineDataset;
    TELEMETRY_API_KEY: string;
}

interface TelemetryEvent {
    name: string;
    timestamp: number;
    toolName?: string;
    success?: boolean;
    duration?: number;
    isFirstRun?: boolean;
    properties?: Record<string, string | number | boolean>;
}

interface TelemetryPayload {
    installationId: string;
    serverVersion: string;
    nodeVersion: string;
    platform: string;
    events: TelemetryEvent[];
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        // CORS headers for preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
                }
            });
        }

        // Only accept POST requests
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }

        // Validate API key
        const apiKey = request.headers.get("X-API-Key");
        if (!apiKey || apiKey !== env.TELEMETRY_API_KEY) {
            return new Response("Unauthorized", { status: 401 });
        }

        // Validate content type
        const contentType = request.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
            return new Response("Invalid content type", { status: 400 });
        }

        try {
            const payload = (await request.json()) as TelemetryPayload;

            // Validate required fields
            if (!payload.installationId || !payload.events || !Array.isArray(payload.events)) {
                return new Response("Invalid payload", { status: 400 });
            }

            // Write events to Analytics Engine
            for (const event of payload.events) {
                env.TELEMETRY.writeDataPoint({
                    blobs: [
                        event.name, // index1: Event name (e.g., "tool_invocation", "session_start")
                        event.toolName || "", // index2: Tool name (for tool_invocation events)
                        event.success !== undefined ? (event.success ? "success" : "failure") : "", // index3: Success/failure
                        payload.platform, // index4: Platform (darwin, linux, win32)
                        payload.serverVersion // index5: Server version
                    ],
                    doubles: [
                        event.duration || 0, // double1: Duration in ms
                        event.isFirstRun ? 1 : 0 // double2: First run flag
                    ],
                    indexes: [
                        payload.installationId.slice(0, 8) // Truncated ID for grouping (privacy)
                    ]
                });
            }

            return new Response(JSON.stringify({ ok: true, eventsReceived: payload.events.length }), {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        } catch {
            return new Response("Server error", { status: 500 });
        }
    }
};
