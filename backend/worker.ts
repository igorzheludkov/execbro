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

    const daysParam = parseInt(url.searchParams.get("days") || "7");
    const isToday = daysParam === 0;
    const isAll = daysParam === -1;

    // Parse excluded users from comma-separated list
    const excludeUsersParam = url.searchParams.get("excludeUsers") || "";
    const excludedUsers = excludeUsersParam
        .split(",")
        .map(u => u.trim().toLowerCase())
        .filter(u => u.length > 0 && u.length <= 8); // Only valid user ID prefixes

    // Build the exclusion filter for SQL
    let userExclusionFilter = "";
    if (excludedUsers.length > 0) {
        const exclusions = excludedUsers.map(u => `index1 NOT LIKE '${u}%'`).join(" AND ");
        userExclusionFilter = `AND ${exclusions}`;
    }

    // Generate SQL time filter: "today" uses midnight UTC, "all" has no restriction, otherwise rolling interval
    const timeFilter = isAll
        ? "1=1"
        : isToday
            ? "timestamp >= toStartOfDay(now())"
            : `timestamp >= NOW() - INTERVAL '${daysParam}' DAY`;

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
                AND ${timeFilter}
                ${userExclusionFilter}
            GROUP BY blob2, blob3
            ORDER BY count DESC
        `;

        // Query 2: Session stats (unique installs + total sessions in one query)
        const sessionStatsQuery = `
            SELECT
                COUNT(DISTINCT index1) as unique_installs,
                SUM(_sample_interval) as total_sessions
            FROM rn_debugger_events
            WHERE
                blob1 = 'session_start'
                AND ${timeFilter}
                ${userExclusionFilter}
        `;

        // Query 3: Timeline (daily counts)
        const timelineQuery = `
            SELECT
                toDate(timestamp) as date,
                SUM(_sample_interval) as count
            FROM rn_debugger_events
            WHERE
                blob1 = 'tool_invocation'
                AND ${timeFilter}
                ${userExclusionFilter}
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
                AND ${timeFilter}
                ${userExclusionFilter}
            LIMIT 50000
        `;

        // Query 5: All session_start events (raw rows to get unique users)
        // Analytics Engine doesn't support GROUP BY or DISTINCT on index columns
        const allUsersQuery = `
            SELECT index1
            FROM rn_debugger_events
            WHERE
                blob1 = 'session_start'
                AND ${timeFilter}
                ${userExclusionFilter}
            LIMIT 10000
        `;

        // Query 6: All tool invocation events (raw rows to count per user)
        const userToolCountsQuery = `
            SELECT index1, _sample_interval as weight
            FROM rn_debugger_events
            WHERE
                blob1 = 'tool_invocation'
                AND ${timeFilter}
                ${userExclusionFilter}
            LIMIT 200000
        `;

        // Execute queries in parallel (max 6 to avoid connection limit)
        const [toolStatsRes, sessionStatsRes, timelineRes, userToolsRes, allUsersRes, userToolCountsRes] = await Promise.all([
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: toolStatsQuery
            }),
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: sessionStatsQuery
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
                body: allUsersQuery
            }),
            fetch(sqlEndpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` },
                body: userToolCountsQuery
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
        const sessionStats = await parseResponse<{
            unique_installs: number;
            total_sessions: number;
        }>(sessionStatsRes, 'sessionStats');
        const timeline = await parseResponse<{ date: string; count: number }>(timelineRes, 'timeline');
        const userTools = await parseResponse<{
            index1: string;
            tool: string;
            weight: number;
        }>(userToolsRes, 'userTools');
        const allUsers = await parseResponse<{
            index1: string;
        }>(allUsersRes, 'allUsers');
        const userToolCounts = await parseResponse<{
            index1: string;
            weight: number;
        }>(userToolCountsRes, 'userToolCounts');

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
        // For "today" (days=0), use 1 day; for "all" use 90 days as baseline; otherwise use the provided days value
        const effectiveDays = isAll ? 90 : (isToday ? 1 : daysParam);
        const weeksInPeriod = Math.max(effectiveDays / 7, 1 / 7); // Minimum is 1/7 week (1 day)
        const activeThresholdPerPeriod = Math.max(1, Math.ceil(5 * weeksInPeriod));

        // Get unique users from session_start raw rows
        const uniqueUserIdsFromSessions = new Set<string>();
        for (const row of allUsers.data || []) {
            if (row.index1) uniqueUserIdsFromSessions.add(row.index1);
        }

        // Build a map of user tool counts from raw rows
        const userToolCountMap = new Map<string, number>();
        for (const row of userToolCounts.data || []) {
            const userId = row.index1 || "unknown";
            const weight = Number(row.weight) || 1;
            userToolCountMap.set(userId, (userToolCountMap.get(userId) || 0) + weight);
        }

        // Combine users from both session_start and tool_invocation events
        // This ensures users who started sessions before the period but used tools
        // during the period are still counted
        const allUniqueUserIds = new Set<string>([
            ...uniqueUserIdsFromSessions,
            ...userToolCountMap.keys()
        ]);

        let activeUsers = 0;
        let inactiveUsers = 0;
        const userActivityList: Array<{
            userId: string;
            totalCalls: number;
            callsPerWeek: number;
            isActive: boolean;
        }> = [];

        // Include users from both session_start and tool_invocation events
        for (const userId of allUniqueUserIds) {
            const totalUserCalls = userToolCountMap.get(userId) || 0;
            const callsPerWeek = totalUserCalls / weeksInPeriod;
            const isActive = totalUserCalls >= activeThresholdPerPeriod;

            if (isActive) {
                activeUsers++;
            } else {
                inactiveUsers++;
            }

            userActivityList.push({
                userId,
                totalCalls: totalUserCalls,
                callsPerWeek: Math.round(callsPerWeek * 10) / 10,
                isActive
            });
        }

        // Sort by activity level
        userActivityList.sort((a, b) => b.totalCalls - a.totalCalls);

        return new Response(JSON.stringify({
            totalCalls,
            totalSessions: Number(sessionStats.data?.[0]?.total_sessions) || 0,
            uniqueInstalls: Number(sessionStats.data?.[0]?.unique_installs) || 0,
            successRate,
            avgDuration,
            toolBreakdown,
            timeline: (timeline.data || []).map(t => ({ date: t.date, count: Number(t.count) || 0 })),
            // New fields
            userToolsBreakdown,
            userActivity: {
                activeUsers,
                inactiveUsers,
                activeThreshold: activeThresholdPerPeriod,
                periodDays: effectiveDays,
                periodType: isAll ? 'all' : (isToday ? 'today' : 'days'),
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
