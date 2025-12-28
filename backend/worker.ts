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

    const sqlEndpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;

    try {
        // Query 1: Tool breakdown with success/failure counts and durations
        const toolStatsQuery = `
            SELECT
                blob2 as tool,
                blob3 as status,
                SUM(_sample_interval) as count,
                SUM(double1 * _sample_interval) as total_duration
            FROM rn_debugger_events
            WHERE
                blob1 = 'tool_invocation'
                AND timestamp >= NOW() - INTERVAL '${days}' DAY
            GROUP BY blob2, blob3
            ORDER BY count DESC
        `;

        // Query 2: Unique installations
        const uniqueInstallsQuery = `
            SELECT COUNT(DISTINCT index1) as unique_installs
            FROM rn_debugger_events
            WHERE
                blob1 = 'session_start'
                AND timestamp >= NOW() - INTERVAL '${days}' DAY
        `;

        // Query 3: Timeline (daily counts)
        const timelineQuery = `
            SELECT
                toDate(timestamp) as date,
                SUM(_sample_interval) as count
            FROM rn_debugger_events
            WHERE
                blob1 = 'tool_invocation'
                AND timestamp >= NOW() - INTERVAL '${days}' DAY
            GROUP BY date
            ORDER BY date ASC
        `;

        // Query 4: Tools usage by user
        // Note: Analytics Engine may have issues with index columns in GROUP BY,
        // so we select each row and process in JS
        const userToolsQuery = `
            SELECT
                index1,
                blob2 as tool,
                _sample_interval as weight
            FROM rn_debugger_events
            WHERE
                blob1 = 'tool_invocation'
                AND timestamp >= NOW() - INTERVAL '${days}' DAY
            LIMIT 1000
        `;

        // Query 5: Active vs inactive users (active = 5+ tool calls per week)
        // We calculate weekly average based on total calls / weeks in period
        const userActivityQuery = `
            SELECT
                index1 as user_id,
                SUM(_sample_interval) as total_calls
            FROM rn_debugger_events
            WHERE
                blob1 = 'tool_invocation'
                AND timestamp >= NOW() - INTERVAL '${days}' DAY
            GROUP BY index1
        `;

        // Execute queries in parallel
        const [toolStatsRes, uniqueInstallsRes, timelineRes, userToolsRes, userActivityRes] = await Promise.all([
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: toolStatsQuery
            }),
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: uniqueInstallsQuery
            }),
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: timelineQuery
            }),
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: userToolsQuery
            }),
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: userActivityQuery
            })
        ]);

        interface SqlResponse<T> {
            data?: T[];
            errors?: Array<{ message: string }>;
        }

        // Helper to safely parse JSON response
        async function parseResponse<T>(res: Response, queryName: string): Promise<SqlResponse<T>> {
            const text = await res.text();
            try {
                return JSON.parse(text) as SqlResponse<T>;
            } catch {
                console.error(`Failed to parse ${queryName}:`, text.slice(0, 200));
                return { data: [], errors: [{ message: `Invalid response for ${queryName}` }] };
            }
        }

        const toolStats = await parseResponse<{
            tool: string;
            status: string;
            count: number;
            total_duration: number;
        }>(toolStatsRes, 'toolStats');
        const uniqueInstalls = await parseResponse<{ unique_installs: number }>(uniqueInstallsRes, 'uniqueInstalls');
        const timeline = await parseResponse<{ date: string; count: number }>(timelineRes, 'timeline');
        const userTools = await parseResponse<{
            index1: string;
            tool: string;
            weight: number;
        }>(userToolsRes, 'userTools');
        const userActivity = await parseResponse<{
            user_id: string;
            total_calls: number;
        }>(userActivityRes, 'userActivity');

        // Check for errors
        if (toolStats.errors?.length) {
            return new Response(JSON.stringify({ error: toolStats.errors[0].message }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS }
            });
        }

        // Process tool stats into breakdown
        const toolMap = new Map<string, { count: number; success: number; totalDuration: number }>();

        for (const row of toolStats.data || []) {
            const tool = row.tool || "unknown";
            if (!toolMap.has(tool)) {
                toolMap.set(tool, { count: 0, success: 0, totalDuration: 0 });
            }
            const entry = toolMap.get(tool)!;
            const rowCount = Number(row.count) || 0;
            const rowDuration = Number(row.total_duration) || 0;
            entry.count += rowCount;
            if (row.status === "success") entry.success += rowCount;
            entry.totalDuration += rowDuration;
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
        const totalSuccess = toolBreakdown.reduce((sum, t) => sum + t.count * t.successRate / 100, 0);
        const successRate = totalCalls > 0 ? (totalSuccess / totalCalls) * 100 : 0;
        const avgDuration = totalCalls > 0
            ? toolBreakdown.reduce((sum, t) => sum + t.avgDuration * t.count, 0) / totalCalls
            : 0;

        // Process user tools breakdown (aggregate in JS since SQL GROUP BY on index1 fails)
        const userToolsMap = new Map<string, Map<string, number>>();
        for (const row of userTools.data || []) {
            const userId = row.index1 || "unknown";
            const tool = row.tool || "unknown";
            const weight = Number(row.weight) || 1;

            if (!userToolsMap.has(userId)) {
                userToolsMap.set(userId, new Map());
            }
            const toolMap = userToolsMap.get(userId)!;
            toolMap.set(tool, (toolMap.get(tool) || 0) + weight);
        }

        const userToolsBreakdown = Array.from(userToolsMap.entries())
            .map(([userId, toolMap]) => {
                const tools = Array.from(toolMap.entries())
                    .map(([tool, count]) => ({ tool, count }))
                    .sort((a, b) => b.count - a.count);
                return {
                    userId,
                    totalCalls: tools.reduce((sum, t) => sum + t.count, 0),
                    tools
                };
            })
            .sort((a, b) => b.totalCalls - a.totalCalls);

        // Process active vs inactive users
        // Active = 5+ tool calls per week (normalized to the selected period)
        const weeksInPeriod = Math.max(days / 7, 1);
        const activeThresholdPerPeriod = 5 * weeksInPeriod;

        let activeUsers = 0;
        let inactiveUsers = 0;
        const userActivityList: Array<{
            userId: string;
            totalCalls: number;
            callsPerWeek: number;
            isActive: boolean;
        }> = [];

        for (const row of userActivity.data || []) {
            const totalUserCalls = Number(row.total_calls) || 0;
            const callsPerWeek = totalUserCalls / weeksInPeriod;
            const isActive = totalUserCalls >= activeThresholdPerPeriod;

            if (isActive) {
                activeUsers++;
            } else {
                inactiveUsers++;
            }

            userActivityList.push({
                userId: row.user_id || "unknown",
                totalCalls: totalUserCalls,
                callsPerWeek: Math.round(callsPerWeek * 10) / 10,
                isActive
            });
        }

        // Sort by activity level
        userActivityList.sort((a, b) => b.totalCalls - a.totalCalls);

        return new Response(JSON.stringify({
            totalCalls,
            uniqueInstalls: Number(uniqueInstalls.data?.[0]?.unique_installs) || 0,
            successRate,
            avgDuration,
            toolBreakdown,
            timeline: (timeline.data || []).map(t => ({ date: t.date, count: Number(t.count) || 0 })),
            // New fields
            userToolsBreakdown,
            userActivity: {
                activeUsers,
                inactiveUsers,
                activeThreshold: 5,
                periodDays: days,
                users: userActivityList
            }
        }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to query analytics", details: String(error) }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
    }
}
