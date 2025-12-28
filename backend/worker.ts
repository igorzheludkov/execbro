/**
 * Cloudflare Worker for React Native AI Debugger Telemetry
 *
 * - Receives anonymous usage telemetry from the MCP server
 * - Stores data in Analytics Engine
 * - Provides dashboard API for querying stats
 */

interface Env {
    TELEMETRY: AnalyticsEngineDataset;
    TELEMETRY_API_KEY: string;
    DASHBOARD_KEY: string;
    CF_ACCOUNT_ID: string;
    CF_API_TOKEN: string;
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

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: CORS_HEADERS });
        }

        // Route handling
        if (url.pathname === "/api/stats" && request.method === "GET") {
            return handleStats(request, env);
        }

        if (url.pathname === "/" && request.method === "POST") {
            return handleTelemetry(request, env);
        }

        // Legacy: POST to root path
        if (request.method === "POST") {
            return handleTelemetry(request, env);
        }

        return new Response("Not found", { status: 404 });
    }
};

async function handleTelemetry(request: Request, env: Env): Promise<Response> {
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
                    event.name,
                    event.toolName || "",
                    event.success !== undefined ? (event.success ? "success" : "failure") : "",
                    payload.platform,
                    payload.serverVersion
                ],
                doubles: [
                    event.duration || 0,
                    event.isFirstRun ? 1 : 0
                ],
                indexes: [
                    payload.installationId.slice(0, 8)
                ]
            });
        }

        return new Response(JSON.stringify({ ok: true, eventsReceived: payload.events.length }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
    } catch {
        return new Response("Server error", { status: 500 });
    }
}

async function handleStats(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Authenticate dashboard access
    const key = url.searchParams.get("key") || request.headers.get("X-Dashboard-Key");
    if (!key || key !== env.DASHBOARD_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
    }

    const days = parseInt(url.searchParams.get("days") || "7");

    // Check if API credentials are configured
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
        return new Response(JSON.stringify({
            error: "Dashboard not configured. Set CF_ACCOUNT_ID and CF_API_TOKEN secrets."
        }), {
            status: 503,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split("T")[0];

    const query = `
        query GetTelemetryStats($accountTag: String!, $startDate: Date!) {
            viewer {
                accounts(filter: { accountTag: $accountTag }) {
                    # Tool invocation stats
                    toolStats: rnDebuggerEventsAdaptiveGroups(
                        filter: {
                            date_geq: $startDate,
                            blob1: "tool_invocation"
                        }
                        limit: 100
                    ) {
                        count
                        dimensions {
                            blob2
                            blob3
                        }
                        sum {
                            double1
                        }
                        avg {
                            double1
                        }
                    }

                    # Unique installations
                    uniqueInstalls: rnDebuggerEventsAdaptiveGroups(
                        filter: {
                            date_geq: $startDate,
                            blob1: "session_start"
                        }
                        limit: 1000
                    ) {
                        count
                        dimensions {
                            index1
                        }
                    }

                    # Timeline data
                    timeline: rnDebuggerEventsAdaptiveGroups(
                        filter: {
                            date_geq: $startDate,
                            blob1: "tool_invocation"
                        }
                        limit: 100
                        orderBy: [date_ASC]
                    ) {
                        count
                        dimensions {
                            date
                        }
                    }
                }
            }
        }
    `;

    try {
        const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.CF_API_TOKEN}`
            },
            body: JSON.stringify({
                query,
                variables: {
                    accountTag: env.CF_ACCOUNT_ID,
                    startDate: startDateStr
                }
            })
        });

        const result = await response.json() as {
            data?: {
                viewer?: {
                    accounts?: Array<{
                        toolStats?: Array<{
                            count: number;
                            dimensions: { blob2: string; blob3: string };
                            sum: { double1: number };
                            avg: { double1: number };
                        }>;
                        uniqueInstalls?: Array<{
                            count: number;
                            dimensions: { index1: string };
                        }>;
                        timeline?: Array<{
                            count: number;
                            dimensions: { date: string };
                        }>;
                    }>;
                };
            };
            errors?: Array<{ message: string }>;
        };

        if (result.errors) {
            return new Response(JSON.stringify({ error: result.errors[0].message }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS }
            });
        }

        const accounts = result.data?.viewer?.accounts;
        if (!accounts || accounts.length === 0) {
            return new Response(JSON.stringify({
                totalCalls: 0,
                uniqueInstalls: 0,
                successRate: 0,
                avgDuration: 0,
                toolBreakdown: [],
                timeline: []
            }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS }
            });
        }

        const account = accounts[0];

        // Process tool stats
        const toolMap = new Map<string, { count: number; success: number; totalDuration: number }>();

        for (const stat of account.toolStats || []) {
            const tool = stat.dimensions.blob2 || "unknown";
            const isSuccess = stat.dimensions.blob3 === "success";

            if (!toolMap.has(tool)) {
                toolMap.set(tool, { count: 0, success: 0, totalDuration: 0 });
            }

            const entry = toolMap.get(tool)!;
            entry.count += stat.count;
            if (isSuccess) entry.success += stat.count;
            entry.totalDuration += stat.sum.double1;
        }

        const toolBreakdown = Array.from(toolMap.entries())
            .map(([tool, data]) => ({
                tool,
                count: data.count,
                successRate: data.count > 0 ? (data.success / data.count) * 100 : 0,
                avgDuration: data.count > 0 ? data.totalDuration / data.count : 0
            }))
            .sort((a, b) => b.count - a.count);

        // Calculate totals
        const totalCalls = toolBreakdown.reduce((sum, t) => sum + t.count, 0);
        const totalSuccess = toolBreakdown.reduce((sum, t) => sum + (t.count * t.successRate / 100), 0);
        const successRate = totalCalls > 0 ? (totalSuccess / totalCalls) * 100 : 0;
        const avgDuration = toolBreakdown.reduce((sum, t) => sum + t.avgDuration * t.count, 0) / (totalCalls || 1);

        // Count unique installations
        const uniqueInstallIds = new Set((account.uniqueInstalls || []).map(u => u.dimensions.index1));

        // Process timeline
        const timeline = (account.timeline || []).map(t => ({
            date: t.dimensions.date,
            count: t.count
        }));

        return new Response(JSON.stringify({
            totalCalls,
            uniqueInstalls: uniqueInstallIds.size,
            successRate,
            avgDuration,
            toolBreakdown,
            timeline
        }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to query analytics" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
    }
}
