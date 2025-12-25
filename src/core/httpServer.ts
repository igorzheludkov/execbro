import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { logBuffer, networkBuffer, bundleErrorBuffer, connectedApps } from "./state.js";

const DEFAULT_HTTP_PORT = 3456;
const MAX_PORT_ATTEMPTS = 20;

// Store the active port for querying via MCP tool
let activeDebugServerPort: number | null = null;

interface DebugServerOptions {
    port?: number;
}

/**
 * Get the port the debug HTTP server is running on (if started)
 */
export function getDebugServerPort(): number | null {
    return activeDebugServerPort;
}

// HTML template with highlight.js and auto-refresh
function htmlTemplate(title: string, content: string, refreshInterval = 3000): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - RN Debugger</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0d1117;
            color: #c9d1d9;
            padding: 20px;
            line-height: 1.5;
        }
        nav {
            background: #161b22;
            padding: 12px 20px;
            margin: -20px -20px 20px -20px;
            border-bottom: 1px solid #30363d;
            display: flex;
            gap: 20px;
            align-items: center;
        }
        nav a {
            color: #58a6ff;
            text-decoration: none;
            padding: 6px 12px;
            border-radius: 6px;
            transition: background 0.2s;
        }
        nav a:hover { background: #21262d; }
        nav a.active { background: #388bfd; color: white; }
        .logo { font-weight: 600; color: #f0f6fc; margin-right: auto; }
        h1 { margin-bottom: 16px; font-size: 1.5em; }
        .stats {
            display: flex;
            gap: 16px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .stat {
            background: #161b22;
            padding: 12px 20px;
            border-radius: 8px;
            border: 1px solid #30363d;
        }
        .stat-value { font-size: 1.5em; font-weight: 600; color: #58a6ff; }
        .stat-label { font-size: 0.85em; color: #8b949e; }
        pre {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 16px;
            overflow-x: auto;
            font-size: 13px;
        }
        code { font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace; }
        .log-entry {
            padding: 8px 12px;
            border-bottom: 1px solid #21262d;
            font-family: 'SF Mono', Consolas, monospace;
            font-size: 13px;
        }
        .log-entry:last-child { border-bottom: none; }
        .log-entry.log { color: #c9d1d9; }
        .log-entry.info { color: #58a6ff; }
        .log-entry.warn { color: #d29922; background: #d299221a; }
        .log-entry.error { color: #f85149; background: #f851491a; }
        .log-entry.debug { color: #8b949e; }
        .log-time { color: #6e7681; margin-right: 12px; }
        .log-level {
            display: inline-block;
            width: 50px;
            text-transform: uppercase;
            font-size: 11px;
            font-weight: 600;
        }
        .network-item { border-bottom: 1px solid #21262d; }
        .network-item:last-child { border-bottom: none; }
        .network-entry {
            padding: 12px;
            display: grid;
            grid-template-columns: 70px 60px 1fr 100px 30px;
            gap: 8px 12px;
            align-items: start;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.15s;
        }
        .network-entry:hover { background: #21262d; }
        .network-main-row {
            display: contents;
        }
        .url-cell {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .method { font-weight: 600; font-family: monospace; }
        .method.GET { color: #58a6ff; }
        .method.POST { color: #3fb950; }
        .method.PUT { color: #d29922; }
        .method.DELETE { color: #f85149; }
        .method.PATCH { color: #a371f7; }
        .status { font-family: monospace; font-weight: 600; }
        .status.s2xx { color: #3fb950; }
        .status.s3xx { color: #58a6ff; }
        .status.s4xx { color: #d29922; }
        .status.s5xx { color: #f85149; }
        .url { color: #c9d1d9; word-break: break-all; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .duration { color: #8b949e; text-align: right; }
        .expand-icon { color: #6e7681; text-align: center; transition: transform 0.2s; }
        .network-item.expanded .expand-icon { transform: rotate(90deg); }
        .network-details {
            display: none;
            padding: 12px 16px;
            background: #0d1117;
            border-top: 1px solid #21262d;
            font-size: 12px;
        }
        .network-item.expanded .network-details { display: block; }
        .detail-section { margin-bottom: 12px; }
        .detail-section:last-child { margin-bottom: 0; }
        .detail-label { color: #8b949e; font-size: 11px; text-transform: uppercase; margin-bottom: 4px; font-weight: 600; }
        .detail-value { font-family: 'SF Mono', Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
        .detail-value.url-full { color: #58a6ff; }
        .headers-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
        .header-name { color: #a371f7; }
        .header-value { color: #c9d1d9; word-break: break-all; }
        .operation-info {
            font-size: 11px;
            color: #8b949e;
            margin-top: 2px;
            font-family: 'SF Mono', Consolas, monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .operation-name { color: #d2a8ff; font-weight: 500; }
        .operation-vars { color: #7ee787; }
        .empty { color: #8b949e; text-align: center; padding: 40px; }
        .app-card {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
        }
        .app-card h3 { margin-bottom: 8px; }
        .app-status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
        .app-status.connected { background: #238636; color: white; }
        .app-status.disconnected { background: #6e7681; color: white; }
        .app-detail { color: #8b949e; font-size: 13px; margin-top: 4px; }
        #content { min-height: 200px; }
    </style>
</head>
<body>
    <nav>
        <span class="logo">RN Debugger</span>
        <a href="/" ${title === 'Dashboard' ? 'class="active"' : ''}>Dashboard</a>
        <a href="/logs" ${title === 'Logs' ? 'class="active"' : ''}>Logs</a>
        <a href="/network" ${title === 'Network' ? 'class="active"' : ''}>Network</a>
        <a href="/apps" ${title === 'Apps' ? 'class="active"' : ''}>Apps</a>
    </nav>
    <div id="content">${content}</div>
    <script>
        hljs.highlightAll();

        function toggleNetworkItem(el) {
            el.closest('.network-item').classList.toggle('expanded');
        }

        ${refreshInterval > 0 ? `
        setInterval(() => {
            fetch(window.location.pathname + '?t=' + Date.now(), {
                headers: { 'Accept': 'text/html' }
            })
            .then(r => r.text())
            .then(html => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const newContent = doc.getElementById('content');
                const oldContent = document.getElementById('content');
                if (newContent && oldContent && newContent.innerHTML !== oldContent.innerHTML) {
                    // Preserve expanded state
                    const expanded = new Set();
                    oldContent.querySelectorAll('.network-item.expanded').forEach(el => {
                        const id = el.getAttribute('data-id');
                        if (id) expanded.add(id);
                    });

                    oldContent.innerHTML = newContent.innerHTML;

                    // Restore expanded state
                    expanded.forEach(id => {
                        const el = oldContent.querySelector('.network-item[data-id="' + id + '"]');
                        if (el) el.classList.add('expanded');
                    });

                    hljs.highlightAll();
                }
            });
        }, ${refreshInterval});
        ` : ''}
    </script>
</body>
</html>`;
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderDashboard(): string {
    const logs = logBuffer.size;
    const network = networkBuffer.size;
    const errors = bundleErrorBuffer.get().length;
    const apps = connectedApps.size;
    const status = bundleErrorBuffer.getStatus();

    return htmlTemplate('Dashboard', `
        <h1>Dashboard</h1>
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${logs}</div>
                <div class="stat-label">Console Logs</div>
            </div>
            <div class="stat">
                <div class="stat-value">${network}</div>
                <div class="stat-label">Network Requests</div>
            </div>
            <div class="stat">
                <div class="stat-value">${errors}</div>
                <div class="stat-label">Bundle Errors</div>
            </div>
            <div class="stat">
                <div class="stat-value">${apps}</div>
                <div class="stat-label">Connected Apps</div>
            </div>
        </div>
        <h2 style="margin: 20px 0 12px;">Bundle Status</h2>
        <pre><code class="language-json">${escapeHtml(JSON.stringify(status, null, 2))}</code></pre>
    `);
}

function renderLogs(): string {
    const logs = logBuffer.getAll();

    if (logs.length === 0) {
        return htmlTemplate('Logs', '<div class="empty">No logs captured yet. Connect to a Metro server and interact with your app.</div>');
    }

    const logsHtml = logs.map(log => {
        const time = formatTime(log.timestamp);
        const message = escapeHtml(log.message);
        return `<div class="log-entry ${log.level}">
            <span class="log-time">${time}</span>
            <span class="log-level">${log.level}</span>
            ${message}
        </div>`;
    }).join('');

    return htmlTemplate('Logs', `
        <h1>Console Logs <span style="color: #8b949e; font-weight: normal;">(${logs.length})</span></h1>
        <pre style="padding: 0;">${logsHtml}</pre>
    `);
}

function formatHeaders(headers: Record<string, string> | undefined): string {
    if (!headers || Object.keys(headers).length === 0) {
        return '<span style="color: #6e7681;">No headers</span>';
    }
    return Object.entries(headers)
        .map(([name, value]) => `<span class="header-name">${escapeHtml(name)}:</span> <span class="header-value">${escapeHtml(value)}</span>`)
        .join('<br>');
}

interface ParsedBody {
    isGraphQL: boolean;
    operationName?: string;
    variables?: Record<string, unknown>;
    bodyPreview?: string;
}

function parseRequestBody(postData: string | undefined): ParsedBody | null {
    if (!postData) return null;

    try {
        const parsed = JSON.parse(postData);

        // Check if it's GraphQL
        if (parsed.query || parsed.operationName) {
            return {
                isGraphQL: true,
                operationName: parsed.operationName,
                variables: parsed.variables
            };
        }

        // REST API - return body preview
        const preview = JSON.stringify(parsed);
        return {
            isGraphQL: false,
            bodyPreview: preview.length > 100 ? preview.substring(0, 100) + '...' : preview
        };
    } catch {
        // Not JSON - return raw preview
        return {
            isGraphQL: false,
            bodyPreview: postData.length > 100 ? postData.substring(0, 100) + '...' : postData
        };
    }
}

function formatVariablesCompact(variables: Record<string, unknown> | undefined): string {
    if (!variables || Object.keys(variables).length === 0) return '';

    const parts = Object.entries(variables).map(([key, value]) => {
        let valStr: string;
        if (typeof value === 'string') {
            valStr = `"${value.length > 15 ? value.substring(0, 15) + '...' : value}"`;
        } else if (typeof value === 'object' && value !== null) {
            valStr = Array.isArray(value) ? `[${value.length}]` : '{...}';
        } else {
            valStr = String(value);
        }
        return `${key}: ${valStr}`;
    });

    const result = parts.join(', ');
    return result.length > 60 ? result.substring(0, 60) + '...' : result;
}

function renderNetwork(): string {
    const requests = networkBuffer.getAll({});

    if (requests.length === 0) {
        return htmlTemplate('Network', '<div class="empty">No network requests captured yet. Connect to a Metro server and interact with your app.</div>');
    }

    const requestsHtml = requests.map(req => {
        const statusClass = req.status ? `s${Math.floor(req.status / 100)}xx` : '';
        const duration = req.timing?.duration ? `${Math.round(req.timing.duration)}ms` : '-';
        const url = escapeHtml(req.url);
        const requestId = escapeHtml(req.requestId);

        // Parse body for operation info
        const parsedBody = parseRequestBody(req.postData);

        // Build details section
        const details: string[] = [];

        // Full URL
        details.push(`
            <div class="detail-section">
                <div class="detail-label">URL</div>
                <div class="detail-value url-full">${url}</div>
            </div>
        `);

        // Timing
        if (req.timing) {
            details.push(`
                <div class="detail-section">
                    <div class="detail-label">Timing</div>
                    <div class="detail-value">Duration: ${duration}</div>
                </div>
            `);
        }

        // Request Headers
        details.push(`
            <div class="detail-section">
                <div class="detail-label">Request Headers</div>
                <div class="detail-value">${formatHeaders(req.headers)}</div>
            </div>
        `);

        // Request Body (POST data)
        if (req.postData) {
            let formattedBody = escapeHtml(req.postData);
            try {
                const parsed = JSON.parse(req.postData);
                formattedBody = `<code class="language-json">${escapeHtml(JSON.stringify(parsed, null, 2))}</code>`;
            } catch {
                // Not JSON, use as-is
            }
            details.push(`
                <div class="detail-section">
                    <div class="detail-label">Request Body</div>
                    <pre style="margin: 0; padding: 8px; font-size: 11px;">${formattedBody}</pre>
                </div>
            `);
        }

        // Response Headers
        if (req.responseHeaders && Object.keys(req.responseHeaders).length > 0) {
            details.push(`
                <div class="detail-section">
                    <div class="detail-label">Response Headers</div>
                    <div class="detail-value">${formatHeaders(req.responseHeaders)}</div>
                </div>
            `);
        }

        // Response info
        if (req.mimeType || req.contentLength) {
            const info = [];
            if (req.mimeType) info.push(`Type: ${escapeHtml(req.mimeType)}`);
            if (req.contentLength) info.push(`Size: ${req.contentLength} bytes`);
            details.push(`
                <div class="detail-section">
                    <div class="detail-label">Response Info</div>
                    <div class="detail-value">${info.join(' | ')}</div>
                </div>
            `);
        }

        // Error
        if (req.error) {
            details.push(`
                <div class="detail-section">
                    <div class="detail-label" style="color: #f85149;">Error</div>
                    <div class="detail-value" style="color: #f85149;">${escapeHtml(req.error)}</div>
                </div>
            `);
        }

        // Build operation info line for compact view
        let operationInfo = '';
        if (parsedBody) {
            if (parsedBody.isGraphQL && parsedBody.operationName) {
                const varsStr = formatVariablesCompact(parsedBody.variables);
                operationInfo = `<div class="operation-info"><span class="operation-name">${escapeHtml(parsedBody.operationName)}</span>${varsStr ? ` <span class="operation-vars">(${escapeHtml(varsStr)})</span>` : ''}</div>`;
            } else if (!parsedBody.isGraphQL && parsedBody.bodyPreview) {
                operationInfo = `<div class="operation-info">${escapeHtml(parsedBody.bodyPreview)}</div>`;
            }
        }

        return `<div class="network-item" data-id="${requestId}">
            <div class="network-entry" onclick="toggleNetworkItem(this)">
                <span class="method ${req.method}">${req.method}</span>
                <span class="status ${statusClass}">${req.status || '-'}</span>
                <div class="url-cell">
                    <span class="url" title="${url}">${url}</span>
                    ${operationInfo}
                </div>
                <span class="duration">${duration}</span>
                <span class="expand-icon">▶</span>
            </div>
            <div class="network-details">
                ${details.join('')}
            </div>
        </div>`;
    }).join('');

    return htmlTemplate('Network', `
        <h1>Network Requests <span style="color: #8b949e; font-weight: normal;">(${requests.length})</span></h1>
        <div style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden;">${requestsHtml}</div>
    `);
}

function renderApps(): string {
    const apps = Array.from(connectedApps.entries()).map(([id, app]) => ({
        id,
        deviceInfo: app.deviceInfo,
        port: app.port,
        connected: app.ws.readyState === 1
    }));

    if (apps.length === 0) {
        return htmlTemplate('Apps', '<div class="empty">No apps connected. Use scan_metro to connect to a running Metro server.</div>');
    }

    const appsHtml = apps.map(app => `
        <div class="app-card">
            <h3>${escapeHtml(app.deviceInfo.title)}</h3>
            <span class="app-status ${app.connected ? 'connected' : 'disconnected'}">
                ${app.connected ? 'Connected' : 'Disconnected'}
            </span>
            <div class="app-detail">Device: ${escapeHtml(app.deviceInfo.deviceName)}</div>
            <div class="app-detail">Metro Port: ${app.port}</div>
            <div class="app-detail">ID: ${escapeHtml(app.id)}</div>
        </div>
    `).join('');

    return htmlTemplate('Apps', `
        <h1>Connected Apps</h1>
        ${appsHtml}
    `);
}

function createRequestHandler() {
    return (req: IncomingMessage, res: ServerResponse) => {
        // Set CORS headers for browser access
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
            res.statusCode = 204;
            res.end();
            return;
        }

        const url = (req.url ?? "/").split('?')[0]; // Remove query params

        try {
            // HTML endpoints
            if (url === "/") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderDashboard());
                return;
            }
            if (url === "/logs") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderLogs());
                return;
            }
            if (url === "/network") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderNetwork());
                return;
            }
            if (url === "/apps") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderApps());
                return;
            }

            // JSON API endpoints
            res.setHeader("Content-Type", "application/json");

            if (url === "/api/logs" || url === "/api/logs/") {
                const logs = logBuffer.getAll();
                res.end(JSON.stringify({ count: logs.length, logs }, null, 2));
            } else if (url === "/api/network" || url === "/api/network/") {
                const requests = networkBuffer.getAll({});
                res.end(JSON.stringify({ count: requests.length, requests }, null, 2));
            } else if (url === "/api/bundle-errors" || url === "/api/bundle-errors/") {
                const errors = bundleErrorBuffer.get();
                const status = bundleErrorBuffer.getStatus();
                res.end(JSON.stringify({ status, count: errors.length, errors }, null, 2));
            } else if (url === "/api/apps" || url === "/api/apps/") {
                const apps = Array.from(connectedApps.entries()).map(([id, app]) => ({
                    id,
                    deviceInfo: app.deviceInfo,
                    port: app.port,
                    connected: app.ws.readyState === 1 // WebSocket.OPEN
                }));
                res.end(JSON.stringify({ count: apps.length, apps }, null, 2));
            } else if (url === "/api/status" || url === "/api/status/") {
                const status = {
                    logs: logBuffer.size,
                    networkRequests: networkBuffer.size,
                    bundleErrors: bundleErrorBuffer.get().length,
                    connectedApps: connectedApps.size,
                    bundleStatus: bundleErrorBuffer.getStatus()
                };
                res.end(JSON.stringify(status, null, 2));
            } else if (url === "/api" || url === "/api/") {
                const endpoints = {
                    message: "React Native AI Debugger - Debug HTTP Server",
                    html: {
                        "/": "Dashboard",
                        "/logs": "Console logs (colored)",
                        "/network": "Network requests",
                        "/apps": "Connected apps"
                    },
                    api: {
                        "/api/status": "Overall server status and buffer sizes",
                        "/api/logs": "All captured console logs (JSON)",
                        "/api/network": "All captured network requests (JSON)",
                        "/api/bundle-errors": "Metro bundle/compilation errors (JSON)",
                        "/api/apps": "Connected React Native apps (JSON)"
                    }
                };
                res.end(JSON.stringify(endpoints, null, 2));
            } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "Not found", path: url }));
            }
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(error) }));
        }
    };
}

function tryListenOnPort(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
            server.removeListener("error", onError);
            if (err.code === "EADDRINUSE") {
                reject(new Error(`Port ${port} in use`));
            } else {
                reject(err);
            }
        };

        server.once("error", onError);

        server.listen(port, () => {
            server.removeListener("error", onError);
            resolve(port);
        });
    });
}

/**
 * Start a debug HTTP server to expose buffer contents.
 * Automatically finds an available port starting from the default.
 */
export async function startDebugHttpServer(options: DebugServerOptions = {}): Promise<number | null> {
    const startPort = options.port ?? DEFAULT_HTTP_PORT;
    const server = createServer(createRequestHandler());

    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
        const port = startPort + attempt;
        try {
            await tryListenOnPort(server, port);
            activeDebugServerPort = port;
            console.error(`[rn-ai-debugger] Debug HTTP server running on http://localhost:${port}`);
            return port;
        } catch {
            // Port in use, try next one
        }
    }

    console.error(`[rn-ai-debugger] Could not find available port for debug HTTP server (tried ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1})`);
    return null;
}
