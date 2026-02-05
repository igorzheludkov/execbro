import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { logBuffer, networkBuffer, bundleErrorBuffer, connectedApps } from "./state.js";
import {
    listAndroidDevices,
    androidScreenshot,
    androidGetScreenSize,
    androidTap
} from "./android.js";
import {
    listIOSSimulators,
    iosScreenshot,
    iosTap
} from "./ios.js";
import { recognizeText, inferIOSDevicePixelRatio } from "./ocr.js";
import {
    getAllConnectionStates,
    getContextHealth
} from "./connectionState.js";
import {
    executeInApp,
    getComponentTree,
    listDebugGlobals,
    inspectGlobal
} from "./executor.js";

const DEFAULT_HTTP_PORT = 3456;
const MAX_PORT_ATTEMPTS = 20;

// Store the active port for querying via MCP tool
let activeDebugServerPort: number | null = null;

// Store markers added by the agent for tap verification
interface TapMarker {
    x: number;
    y: number;
    label?: string;
    color?: string;
    timestamp: number;
}
let tapVerifierMarkers: TapMarker[] = [];

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
        <a href="/bundle-errors" ${title === 'Bundle Errors' ? 'class="active"' : ''}>Errors</a>
        <a href="/apps" ${title === 'Apps' ? 'class="active"' : ''}>Apps</a>
        <a href="/repl" ${title === 'REPL' ? 'class="active"' : ''}>REPL</a>
        <a href="/component-tree" ${title === 'Component Tree' ? 'class="active"' : ''}>Components</a>
        <a href="/globals" ${title === 'Globals' ? 'class="active"' : ''}>Globals</a>
        <a href="/tap-verifier" ${title === 'Tap Verifier' ? 'class="active"' : ''}>Tap Verifier</a>
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

    const connectionStates = getAllConnectionStates();

    const appsHtml = apps.map(app => {
        const state = connectionStates.get(app.id);
        const health = getContextHealth(app.id);

        let uptimeStr = '-';
        if (state?.lastConnectedTime) {
            const uptimeMs = Date.now() - state.lastConnectedTime.getTime();
            const uptimeSec = Math.floor(uptimeMs / 1000);
            if (uptimeSec < 60) uptimeStr = `${uptimeSec}s`;
            else if (uptimeSec < 3600) uptimeStr = `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
            else uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
        }

        const healthStatus = health?.isStale ? 'stale' : 'healthy';
        const healthClass = health?.isStale ? 'health-stale' : 'health-ok';

        // Get gaps for this specific app
        const appGaps = state?.connectionGaps || [];
        const recentAppGaps = appGaps.slice(-3);

        const gapsHtml = recentAppGaps.length > 0 ? `
            <div class="app-detail" style="margin-top: 8px;">
                <strong>Recent Gaps:</strong>
                ${recentAppGaps.map(gap => {
                    const duration = gap.durationMs ? `${Math.round(gap.durationMs / 1000)}s` : 'ongoing';
                    return `<div style="color: #d29922; font-size: 12px; margin-left: 8px;">• ${escapeHtml(gap.reason)} (${duration})</div>`;
                }).join('')}
            </div>
        ` : '';

        return `
            <div class="app-card">
                <h3>${escapeHtml(app.deviceInfo.title)}</h3>
                <span class="app-status ${app.connected ? 'connected' : 'disconnected'}">
                    ${app.connected ? 'Connected' : 'Disconnected'}
                </span>
                <span class="app-status ${healthClass}" style="margin-left: 8px;">
                    Context: ${healthStatus}
                </span>
                <div class="app-detail">Device: ${escapeHtml(app.deviceInfo.deviceName)}</div>
                <div class="app-detail">Metro Port: ${app.port}</div>
                <div class="app-detail">Uptime: ${uptimeStr}</div>
                <div class="app-detail">ID: ${escapeHtml(app.id)}</div>
                ${gapsHtml}
            </div>
        `;
    }).join('');

    return htmlTemplate('Apps', `
        <style>
            .health-ok { background: #238636; color: white; }
            .health-stale { background: #d29922; color: #333; }
        </style>
        <h1>Connected Apps</h1>
        ${appsHtml}
    `);
}

function renderBundleErrors(): string {
    const errors = bundleErrorBuffer.get();
    const status = bundleErrorBuffer.getStatus();

    const statusText = status.hasError ? 'Build Failed' : 'Build OK';

    let content = `
        <h1>Bundle Errors</h1>
        <div class="stats">
            <div class="stat">
                <div class="stat-value" style="color: ${status.hasError ? '#f85149' : '#3fb950'};">${statusText}</div>
                <div class="stat-label">Build Status</div>
            </div>
            <div class="stat">
                <div class="stat-value">${errors.length}</div>
                <div class="stat-label">Errors</div>
            </div>
            ${status.lastBuildTimestamp ? `
            <div class="stat">
                <div class="stat-value">${formatTime(status.lastBuildTimestamp)}</div>
                <div class="stat-label">Last Build</div>
            </div>
            ` : ''}
        </div>
    `;

    if (errors.length === 0) {
        content += '<div class="empty" style="margin-top: 20px;">No bundle errors. Your app is building successfully!</div>';
    } else {
        const errorsHtml = errors.map((error, index) => {
            const location = error.line ? `Line ${error.line}${error.column ? `:${error.column}` : ''}` : '';
            return `
                <div class="error-card" style="background: #161b22; border: 1px solid #f85149; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                        <strong style="color: #f85149;">Error ${index + 1}</strong>
                        ${location ? `<span style="color: #8b949e; font-size: 12px;">${location}</span>` : ''}
                    </div>
                    ${error.file ? `<div style="color: #58a6ff; font-size: 13px; margin-bottom: 8px; font-family: monospace;">${escapeHtml(error.file)}</div>` : ''}
                    <pre style="margin: 0; padding: 12px; background: #0d1117; border-radius: 4px; overflow-x: auto; white-space: pre-wrap;"><code style="color: #f85149;">${escapeHtml(error.message)}</code></pre>
                    ${error.codeFrame ? `
                        <div style="margin-top: 12px;">
                            <div style="color: #8b949e; font-size: 11px; margin-bottom: 4px;">Code Frame:</div>
                            <pre style="margin: 0; padding: 12px; background: #0d1117; border-radius: 4px; overflow-x: auto;"><code class="language-javascript">${escapeHtml(error.codeFrame)}</code></pre>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        content += `<div style="margin-top: 20px;">${errorsHtml}</div>`;
    }

    return htmlTemplate('Bundle Errors', content);
}

function renderRepl(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>REPL - RN Debugger</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
        .repl-container {
            display: flex;
            flex-direction: column;
            gap: 16px;
            height: calc(100vh - 140px);
        }
        .input-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .input-section label {
            color: #8b949e;
            font-size: 13px;
        }
        #codeInput {
            width: 100%;
            height: 150px;
            padding: 12px;
            font-family: 'SF Mono', Consolas, monospace;
            font-size: 14px;
            background: #161b22;
            color: #c9d1d9;
            border: 1px solid #30363d;
            border-radius: 8px;
            resize: vertical;
        }
        #codeInput:focus {
            outline: none;
            border-color: #58a6ff;
        }
        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn-primary {
            background: #238636;
            color: white;
        }
        .btn-primary:hover { background: #2ea043; }
        .btn-primary:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; }
        .btn-secondary {
            background: #21262d;
            color: #c9d1d9;
        }
        .btn-secondary:hover { background: #30363d; }
        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #8b949e;
            font-size: 13px;
        }
        .output-section {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-height: 0;
        }
        .output-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .output-header label {
            color: #8b949e;
            font-size: 13px;
        }
        #output {
            flex: 1;
            padding: 12px;
            font-family: 'SF Mono', Consolas, monospace;
            font-size: 13px;
            background: #161b22;
            color: #c9d1d9;
            border: 1px solid #30363d;
            border-radius: 8px;
            overflow: auto;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .output-success { color: #3fb950; }
        .output-error { color: #f85149; }
        .history-section {
            margin-top: 16px;
        }
        .history-section h3 {
            color: #8b949e;
            font-size: 13px;
            margin-bottom: 8px;
        }
        .history-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .history-item {
            padding: 4px 10px;
            background: #21262d;
            border-radius: 4px;
            font-size: 12px;
            font-family: monospace;
            cursor: pointer;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .history-item:hover { background: #30363d; }
    </style>
</head>
<body>
    <nav>
        <span class="logo">RN Debugger</span>
        <a href="/">Dashboard</a>
        <a href="/logs">Logs</a>
        <a href="/network">Network</a>
        <a href="/bundle-errors">Errors</a>
        <a href="/apps">Apps</a>
        <a href="/repl" class="active">REPL</a>
        <a href="/component-tree">Components</a>
        <a href="/globals">Globals</a>
        <a href="/tap-verifier">Tap Verifier</a>
    </nav>
    <h1>JavaScript REPL</h1>
    <div class="repl-container">
        <div class="input-section">
            <label>Enter JavaScript expression to execute in the app:</label>
            <textarea id="codeInput" placeholder="// Example: get current navigation state
global.__REACT_NAVIGATION__?.current?.getRootState()

// Or inspect React DevTools hook
Object.keys(globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {})"></textarea>
            <div class="controls">
                <button class="btn btn-primary" id="executeBtn" onclick="executeCode()">Execute</button>
                <button class="btn btn-secondary" onclick="clearOutput()">Clear Output</button>
                <label class="checkbox-label">
                    <input type="checkbox" id="awaitPromise" checked>
                    Await Promises
                </label>
            </div>
        </div>
        <div class="output-section">
            <div class="output-header">
                <label>Output:</label>
                <span id="execTime" style="color: #6e7681; font-size: 12px;"></span>
            </div>
            <div id="output"><span style="color: #6e7681;">Output will appear here...</span></div>
        </div>
        <div class="history-section">
            <h3>History</h3>
            <div class="history-list" id="historyList"></div>
        </div>
    </div>
    <script>
        const MAX_HISTORY = 10;
        let history = JSON.parse(localStorage.getItem('repl-history') || '[]');

        function updateHistoryUI() {
            const list = document.getElementById('historyList');
            list.innerHTML = history.map((item, i) =>
                '<div class="history-item" onclick="loadHistory(' + i + ')" title="' + item.replace(/"/g, '&quot;') + '">' + item.slice(0, 50) + (item.length > 50 ? '...' : '') + '</div>'
            ).join('');
        }

        function loadHistory(index) {
            document.getElementById('codeInput').value = history[index];
        }

        function addToHistory(code) {
            // Remove if already exists
            history = history.filter(h => h !== code);
            // Add to front
            history.unshift(code);
            // Limit size
            history = history.slice(0, MAX_HISTORY);
            localStorage.setItem('repl-history', JSON.stringify(history));
            updateHistoryUI();
        }

        async function executeCode() {
            const code = document.getElementById('codeInput').value.trim();
            if (!code) return;

            const output = document.getElementById('output');
            const execTime = document.getElementById('execTime');
            const btn = document.getElementById('executeBtn');
            const awaitPromise = document.getElementById('awaitPromise').checked;

            btn.disabled = true;
            btn.textContent = 'Executing...';
            output.innerHTML = '<span style="color: #8b949e;">Executing...</span>';
            execTime.textContent = '';

            const startTime = Date.now();

            try {
                const res = await fetch('/api/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expression: code, awaitPromise })
                });
                const data = await res.json();
                const elapsed = Date.now() - startTime;
                execTime.textContent = elapsed + 'ms';

                if (data.success) {
                    output.innerHTML = '<span class="output-success">' + formatOutput(data.result) + '</span>';
                    addToHistory(code);
                } else {
                    output.innerHTML = '<span class="output-error">Error: ' + escapeHtml(data.error || 'Unknown error') + '</span>';
                }
            } catch (err) {
                output.innerHTML = '<span class="output-error">Request failed: ' + escapeHtml(err.message) + '</span>';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Execute';
            }
        }

        function formatOutput(result) {
            if (result === undefined || result === 'undefined') return 'undefined';
            if (result === null || result === 'null') return 'null';
            try {
                const parsed = typeof result === 'string' ? JSON.parse(result) : result;
                return escapeHtml(JSON.stringify(parsed, null, 2));
            } catch {
                return escapeHtml(String(result));
            }
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function clearOutput() {
            document.getElementById('output').innerHTML = '<span style="color: #6e7681;">Output will appear here...</span>';
            document.getElementById('execTime').textContent = '';
        }

        // Keyboard shortcut: Ctrl/Cmd + Enter to execute
        document.getElementById('codeInput').addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                executeCode();
            }
        });

        // Init history
        updateHistoryUI();
    </script>
</body>
</html>`;
}

function renderComponentTree(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Component Tree - RN Debugger</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn-primary {
            background: #238636;
            color: white;
        }
        .btn-primary:hover { background: #2ea043; }
        .btn-primary:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; }
        .btn-secondary {
            background: #21262d;
            color: #c9d1d9;
        }
        .btn-secondary:hover { background: #30363d; }
        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #8b949e;
            font-size: 13px;
        }
        #searchInput {
            padding: 8px 12px;
            border: 1px solid #30363d;
            border-radius: 6px;
            background: #161b22;
            color: #c9d1d9;
            font-size: 14px;
            width: 200px;
        }
        #searchInput:focus {
            outline: none;
            border-color: #58a6ff;
        }
        .tree-container {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 16px;
            overflow: auto;
            max-height: calc(100vh - 220px);
        }
        .tree-content {
            font-family: 'SF Mono', Consolas, monospace;
            font-size: 13px;
            white-space: pre;
            line-height: 1.6;
        }
        .tree-content .component { color: #7ee787; }
        .tree-content .props { color: #d2a8ff; }
        .tree-content .layout { color: #79c0ff; }
        .loading { color: #8b949e; text-align: center; padding: 40px; }
        .error { color: #f85149; padding: 20px; }
        .focused-screen {
            background: #388bfd33;
            padding: 8px 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 14px;
        }
        .focused-screen strong { color: #58a6ff; }
        .stats {
            color: #8b949e;
            font-size: 12px;
            margin-bottom: 12px;
        }
    </style>
</head>
<body>
    <nav>
        <span class="logo">RN Debugger</span>
        <a href="/">Dashboard</a>
        <a href="/logs">Logs</a>
        <a href="/network">Network</a>
        <a href="/bundle-errors">Errors</a>
        <a href="/apps">Apps</a>
        <a href="/repl">REPL</a>
        <a href="/component-tree" class="active">Components</a>
        <a href="/globals">Globals</a>
        <a href="/tap-verifier">Tap Verifier</a>
    </nav>
    <h1>React Component Tree</h1>
    <div class="controls">
        <button class="btn btn-primary" id="refreshBtn" onclick="loadTree()">Refresh</button>
        <input type="text" id="searchInput" placeholder="Filter components..." oninput="filterTree()">
        <label class="checkbox-label">
            <input type="checkbox" id="focusedOnly" checked onchange="loadTree()">
            Focused Screen Only
        </label>
        <label class="checkbox-label">
            <input type="checkbox" id="structureOnly" checked onchange="loadTree()">
            Structure Only (Compact)
        </label>
        <label class="checkbox-label">
            <input type="checkbox" id="includeProps" onchange="loadTree()">
            Include Props
        </label>
    </div>
    <div id="focusedInfo"></div>
    <div id="stats" class="stats"></div>
    <div class="tree-container">
        <div class="tree-content" id="treeContent">
            <div class="loading">Click "Refresh" to load the component tree...</div>
        </div>
    </div>
    <script>
        let fullTree = '';

        async function loadTree() {
            const content = document.getElementById('treeContent');
            const focusedInfo = document.getElementById('focusedInfo');
            const stats = document.getElementById('stats');
            const btn = document.getElementById('refreshBtn');

            const focusedOnly = document.getElementById('focusedOnly').checked;
            const structureOnly = document.getElementById('structureOnly').checked;
            const includeProps = document.getElementById('includeProps').checked;

            btn.disabled = true;
            btn.textContent = 'Loading...';
            content.innerHTML = '<div class="loading">Loading component tree...</div>';
            focusedInfo.innerHTML = '';
            stats.textContent = '';

            try {
                const params = new URLSearchParams({
                    focusedOnly: focusedOnly.toString(),
                    structureOnly: structureOnly.toString(),
                    includeProps: includeProps.toString(),
                    maxDepth: structureOnly ? '50' : '100'
                });

                const res = await fetch('/api/component-tree?' + params);
                const data = await res.json();

                if (data.success) {
                    fullTree = data.result || '';

                    // Check for focused screen info
                    const lines = fullTree.split('\\n');
                    if (lines[0] && lines[0].startsWith('Focused:')) {
                        focusedInfo.innerHTML = '<div class="focused-screen"><strong>' + escapeHtml(lines[0]) + '</strong></div>';
                        fullTree = lines.slice(2).join('\\n');
                    }

                    // Count components
                    const lineCount = fullTree.split('\\n').filter(l => l.trim()).length;
                    stats.textContent = lineCount + ' components';

                    displayTree(fullTree);
                } else {
                    content.innerHTML = '<div class="error">Error: ' + escapeHtml(data.error || 'Unknown error') + '</div>';
                }
            } catch (err) {
                content.innerHTML = '<div class="error">Request failed: ' + escapeHtml(err.message) + '</div>';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Refresh';
            }
        }

        function displayTree(tree) {
            const content = document.getElementById('treeContent');
            // Syntax highlight the tree
            const highlighted = tree
                .split('\\n')
                .map(line => {
                    // Component names (at start of line after indentation)
                    let result = line.replace(/^(\\s*)(\\S+)/, '$1<span class="component">$2</span>');
                    // Props in parentheses
                    result = result.replace(/\\(([^)]+)\\)/g, '<span class="props">($1)</span>');
                    // Layout in brackets
                    result = result.replace(/\\[([^\\]]+)\\]/g, '<span class="layout">[$1]</span>');
                    return result;
                })
                .join('\\n');
            content.innerHTML = highlighted || '<div class="loading">No components found</div>';
        }

        function filterTree() {
            const filter = document.getElementById('searchInput').value.toLowerCase();
            if (!filter) {
                displayTree(fullTree);
                return;
            }

            const filtered = fullTree
                .split('\\n')
                .filter(line => line.toLowerCase().includes(filter))
                .join('\\n');

            displayTree(filtered || 'No matching components');
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }
    </script>
</body>
</html>`;
}

function renderGlobals(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Debug Globals - RN Debugger</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
            margin-bottom: 16px;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn-primary {
            background: #238636;
            color: white;
        }
        .btn-primary:hover { background: #2ea043; }
        .btn-primary:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; }
        .category {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            margin-bottom: 16px;
            overflow: hidden;
        }
        .category-header {
            padding: 12px 16px;
            background: #21262d;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .category-header:hover { background: #30363d; }
        .category-title {
            font-weight: 600;
            color: #58a6ff;
        }
        .category-count {
            color: #8b949e;
            font-size: 13px;
        }
        .category-content {
            padding: 12px 16px;
            display: none;
        }
        .category.expanded .category-content { display: block; }
        .global-item {
            padding: 8px 12px;
            margin: 4px 0;
            background: #0d1117;
            border-radius: 4px;
            font-family: 'SF Mono', Consolas, monospace;
            font-size: 13px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .global-item:hover { background: #21262d; }
        .global-name { color: #7ee787; }
        .inspect-btn {
            padding: 4px 8px;
            background: #388bfd;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
        }
        .inspect-btn:hover { background: #58a6ff; }
        .loading { color: #8b949e; text-align: center; padding: 40px; }
        .error { color: #f85149; padding: 20px; }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            z-index: 1000;
            padding: 40px;
            overflow: auto;
        }
        .modal.visible { display: block; }
        .modal-content {
            max-width: 800px;
            margin: 0 auto;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            overflow: hidden;
        }
        .modal-header {
            padding: 12px 16px;
            background: #21262d;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .modal-title {
            font-weight: 600;
            color: #58a6ff;
            font-family: monospace;
        }
        .close-btn {
            background: none;
            border: none;
            color: #8b949e;
            font-size: 24px;
            cursor: pointer;
        }
        .close-btn:hover { color: #f85149; }
        .modal-body {
            padding: 16px;
            max-height: 70vh;
            overflow: auto;
        }
        .modal-body pre {
            margin: 0;
            padding: 12px;
            background: #0d1117;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 12px;
        }
        .prop-item {
            padding: 8px;
            border-bottom: 1px solid #21262d;
        }
        .prop-item:last-child { border-bottom: none; }
        .prop-name { color: #d2a8ff; }
        .prop-type { color: #8b949e; font-size: 11px; margin-left: 8px; }
        .prop-value { color: #79c0ff; font-family: monospace; font-size: 12px; margin-top: 4px; }
    </style>
</head>
<body>
    <nav>
        <span class="logo">RN Debugger</span>
        <a href="/">Dashboard</a>
        <a href="/logs">Logs</a>
        <a href="/network">Network</a>
        <a href="/bundle-errors">Errors</a>
        <a href="/apps">Apps</a>
        <a href="/repl">REPL</a>
        <a href="/component-tree">Components</a>
        <a href="/globals" class="active">Globals</a>
        <a href="/tap-verifier">Tap Verifier</a>
    </nav>
    <h1>Debug Globals Explorer</h1>
    <div class="controls">
        <button class="btn btn-primary" id="refreshBtn" onclick="loadGlobals()">Refresh</button>
    </div>
    <div id="content">
        <div class="loading">Click "Refresh" to discover debug globals...</div>
    </div>

    <div class="modal" id="inspectModal" onclick="closeModal(event)">
        <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-header">
                <span class="modal-title" id="modalTitle">Global</span>
                <button class="close-btn" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body" id="modalBody">
                Loading...
            </div>
        </div>
    </div>

    <script>
        let globalsData = null;

        async function loadGlobals() {
            const content = document.getElementById('content');
            const btn = document.getElementById('refreshBtn');

            btn.disabled = true;
            btn.textContent = 'Loading...';
            content.innerHTML = '<div class="loading">Scanning for debug globals...</div>';

            try {
                const res = await fetch('/api/globals');
                const data = await res.json();

                if (data.success && data.result) {
                    globalsData = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
                    renderGlobals(globalsData);
                } else {
                    content.innerHTML = '<div class="error">Error: ' + escapeHtml(data.error || 'Unknown error') + '</div>';
                }
            } catch (err) {
                content.innerHTML = '<div class="error">Request failed: ' + escapeHtml(err.message) + '</div>';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Refresh';
            }
        }

        function renderGlobals(categories) {
            const content = document.getElementById('content');
            const html = Object.entries(categories)
                .filter(([_, items]) => items && items.length > 0)
                .map(([category, items]) => {
                    const itemsHtml = items.map(name =>
                        '<div class="global-item">' +
                            '<span class="global-name">' + escapeHtml(name) + '</span>' +
                            '<button class="inspect-btn" onclick="inspectGlobal(\\'' + escapeHtml(name).replace(/'/g, "\\\\'") + '\\')">Inspect</button>' +
                        '</div>'
                    ).join('');
                    return '<div class="category" onclick="toggleCategory(this)">' +
                        '<div class="category-header">' +
                            '<span class="category-title">' + escapeHtml(category) + '</span>' +
                            '<span class="category-count">' + items.length + ' items</span>' +
                        '</div>' +
                        '<div class="category-content" onclick="event.stopPropagation()">' + itemsHtml + '</div>' +
                    '</div>';
                }).join('');

            if (!html) {
                content.innerHTML = '<div class="loading">No debug globals found. Make sure your app has debugging tools enabled (e.g., React DevTools, Apollo Client, Redux).</div>';
            } else {
                content.innerHTML = html;
            }
        }

        function toggleCategory(el) {
            el.classList.toggle('expanded');
        }

        async function inspectGlobal(name) {
            const modal = document.getElementById('inspectModal');
            const title = document.getElementById('modalTitle');
            const body = document.getElementById('modalBody');

            title.textContent = name;
            body.innerHTML = '<div class="loading">Loading...</div>';
            modal.classList.add('visible');

            try {
                const res = await fetch('/api/globals/' + encodeURIComponent(name));
                const data = await res.json();

                if (data.success && data.result) {
                    const result = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
                    if (result.error) {
                        body.innerHTML = '<div class="error">' + escapeHtml(result.error) + '</div>';
                    } else {
                        const propsHtml = Object.entries(result).map(([key, info]) => {
                            const typeInfo = typeof info === 'object' && info !== null ? info : { type: typeof info, value: info };
                            return '<div class="prop-item">' +
                                '<span class="prop-name">' + escapeHtml(key) + '</span>' +
                                '<span class="prop-type">' + escapeHtml(typeInfo.type || 'unknown') + (typeInfo.callable ? ' (callable)' : '') + '</span>' +
                                (typeInfo.preview || typeInfo.value !== undefined ?
                                    '<div class="prop-value">' + escapeHtml(String(typeInfo.preview || typeInfo.value)).slice(0, 200) + '</div>' : '') +
                            '</div>';
                        }).join('');
                        body.innerHTML = propsHtml || '<div class="loading">Empty object</div>';
                    }
                } else {
                    body.innerHTML = '<div class="error">Error: ' + escapeHtml(data.error || 'Unknown error') + '</div>';
                }
            } catch (err) {
                body.innerHTML = '<div class="error">Request failed: ' + escapeHtml(err.message) + '</div>';
            }
        }

        function closeModal(event) {
            if (!event || event.target === document.getElementById('inspectModal')) {
                document.getElementById('inspectModal').classList.remove('visible');
            }
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });
    </script>
</body>
</html>`;
}

function renderTapVerifier(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tap Test Page - RN Debugger</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e;
            color: #eee;
            min-height: 100vh;
        }
        .page-container {
            position: relative;
            width: 100%;
            min-height: 100vh;
        }

        /* Sample UI Elements for Testing */
        .header {
            background: #16213e;
            padding: 20px;
            text-align: center;
            border-bottom: 2px solid #0f3460;
        }
        .header h1 { font-size: 24px; margin-bottom: 8px; }
        .header p { color: #888; font-size: 14px; }

        .button-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
            padding: 20px;
            max-width: 400px;
            margin: 0 auto;
        }
        .test-btn {
            padding: 20px;
            border: none;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.1s;
        }
        .test-btn:active { transform: scale(0.95); }
        .btn-red { background: #e94560; color: white; }
        .btn-blue { background: #0f3460; color: white; }
        .btn-green { background: #1eb980; color: white; }
        .btn-yellow { background: #f39c12; color: #333; }
        .btn-purple { background: #9b59b6; color: white; }
        .btn-cyan { background: #00cec9; color: #333; }

        /* Grid Overlay */
        .grid-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 9998;
            display: none;
        }
        .grid-overlay.visible { display: block; }
        .grid-line-v {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 1px;
            background: rgba(255, 255, 0, 0.6);
        }
        .grid-line-h {
            position: absolute;
            left: 0;
            right: 0;
            height: 1px;
            background: rgba(255, 255, 0, 0.6);
        }
        .grid-label {
            position: absolute;
            background: rgba(0, 0, 0, 0.8);
            color: #ffff00;
            font-size: 10px;
            font-family: monospace;
            padding: 2px 4px;
            border-radius: 2px;
        }
        .grid-toggle {
            position: fixed;
            top: 10px;
            left: 10px;
            background: #ffff00;
            color: #000;
            border: none;
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
            z-index: 10001;
            opacity: 0.8;
        }

        .nav-bar {
            display: flex;
            justify-content: space-around;
            background: #16213e;
            padding: 16px;
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            border-top: 2px solid #0f3460;
        }
        .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            color: #888;
            font-size: 12px;
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
        }
        .nav-item:hover { background: #0f3460; color: #fff; }
        .nav-icon { font-size: 24px; margin-bottom: 4px; }

        .card {
            background: #16213e;
            margin: 20px;
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #0f3460;
        }
        .card h2 { margin-bottom: 12px; font-size: 18px; }
        .card p { color: #888; line-height: 1.6; }

        .input-group {
            margin: 20px;
        }
        .input-group label {
            display: block;
            margin-bottom: 8px;
            color: #888;
        }
        .input-group input {
            width: 100%;
            padding: 14px;
            border: 2px solid #0f3460;
            border-radius: 8px;
            background: #16213e;
            color: #fff;
            font-size: 16px;
        }

        /* Canvas Overlay for Markers */
        #markerCanvas {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: auto;
            z-index: 9999;
            cursor: crosshair;
        }

        /* Marker info panel */
        .marker-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(0,0,0,0.8);
            padding: 12px;
            border-radius: 8px;
            font-size: 12px;
            z-index: 10000;
            max-width: 250px;
        }
        .marker-panel h3 {
            color: #ff6b6b;
            margin-bottom: 8px;
            font-size: 14px;
        }
        .marker-info {
            color: #ccc;
            margin-bottom: 4px;
        }
        .clear-btn {
            margin-top: 8px;
            padding: 6px 12px;
            background: #e94560;
            border: none;
            border-radius: 4px;
            color: white;
            cursor: pointer;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="page-container">
        <div class="header">
            <h1>Tap Test Page</h1>
            <p>Agent marks coordinates here to verify accuracy</p>
        </div>

        <div class="button-grid">
            <button class="test-btn btn-red" onclick="btnClick('Red')">Red</button>
            <button class="test-btn btn-blue" onclick="btnClick('Blue')">Blue</button>
            <button class="test-btn btn-green" onclick="btnClick('Green')">Green</button>
            <button class="test-btn btn-yellow" onclick="btnClick('Yellow')">Yellow</button>
            <button class="test-btn btn-purple" onclick="btnClick('Purple')">Purple</button>
            <button class="test-btn btn-cyan" onclick="btnClick('Cyan')">Cyan</button>
        </div>

        <div class="card">
            <h2>Test Card</h2>
            <p>This is a sample card element. The agent can try to tap on this text or the card itself to test coordinate accuracy.</p>
        </div>

        <div class="input-group">
            <label>Test Input Field</label>
            <input type="text" placeholder="Tap here to focus...">
        </div>

        <div class="card">
            <h2>Instructions</h2>
            <p>1. Agent takes screenshot of this page<br>
               2. Agent identifies element and calculates coordinates<br>
               3. Agent calls /api/tap-verifier/mark with coordinates<br>
               4. Marker appears on canvas overlay<br>
               5. Verify if marker aligns with intended element</p>
        </div>

        <div class="nav-bar">
            <div class="nav-item" onclick="navClick('Home')">
                <span class="nav-icon">🏠</span>
                Home
            </div>
            <div class="nav-item" onclick="navClick('Search')">
                <span class="nav-icon">🔍</span>
                Search
            </div>
            <div class="nav-item" onclick="navClick('Profile')">
                <span class="nav-icon">👤</span>
                Profile
            </div>
            <div class="nav-item" onclick="navClick('Settings')">
                <span class="nav-icon">⚙️</span>
                Settings
            </div>
        </div>
    </div>

    <!-- Grid overlay for coordinate reference -->
    <div class="grid-overlay" id="gridOverlay"></div>
    <button class="grid-toggle" onclick="toggleGrid()">Grid</button>

    <!-- Transparent canvas overlay for markers -->
    <canvas id="markerCanvas"></canvas>

    <!-- Marker info panel -->
    <div class="marker-panel" id="markerPanel" style="display: none;">
        <h3>Agent Markers</h3>
        <div id="markerList"></div>
        <button class="clear-btn" onclick="clearMarkers()">Clear All</button>
    </div>

    <script>
        const canvas = document.getElementById('markerCanvas');
        const ctx = canvas.getContext('2d');
        const markerPanel = document.getElementById('markerPanel');
        const markerList = document.getElementById('markerList');

        let markers = [];

        // Resize canvas to match window
        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            drawMarkers();
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        // Click on canvas to add marker
        canvas.addEventListener('click', async (e) => {
            const x = e.clientX;
            const y = e.clientY;
            try {
                await fetch('/api/tap-verifier/mark', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ x, y, label: 'Click', color: '#00ff88' })
                });
                pollMarkers();
            } catch (err) {
                console.error('Failed to add marker:', err);
            }
        });

        // Button click feedback
        function btnClick(name) {
            console.log('Button clicked:', name);
        }
        function navClick(name) {
            console.log('Nav clicked:', name);
        }

        // Draw all markers
        function drawMarkers() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            markers.forEach((marker, i) => {
                const color = marker.color || '#ff6b6b';
                const x = marker.x;
                const y = marker.y;

                // Draw outer ring (dashed)
                ctx.beginPath();
                ctx.arc(x, y, 30, 0, Math.PI * 2);
                ctx.setLineDash([6, 4]);
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.stroke();
                ctx.setLineDash([]);

                // Draw inner circle
                ctx.beginPath();
                ctx.arc(x, y, 8, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();

                // Draw crosshair
                ctx.beginPath();
                ctx.moveTo(x - 20, y);
                ctx.lineTo(x + 20, y);
                ctx.moveTo(x, y - 20);
                ctx.lineTo(x, y + 20);
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.stroke();

                // Draw label
                const label = marker.label || 'Marker ' + (i + 1);
                const text = label + ' (' + x + ', ' + y + ')';
                ctx.font = 'bold 12px monospace';
                const textWidth = ctx.measureText(text).width;

                ctx.fillStyle = 'rgba(0,0,0,0.8)';
                ctx.fillRect(x + 35, y - 10, textWidth + 10, 22);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 35, y - 10, textWidth + 10, 22);

                ctx.fillStyle = color;
                ctx.fillText(text, x + 40, y + 5);
            });

            updateMarkerPanel();
        }

        // Update marker panel
        function updateMarkerPanel() {
            if (markers.length === 0) {
                markerPanel.style.display = 'none';
                return;
            }

            markerPanel.style.display = 'block';
            markerList.innerHTML = markers.map((m, i) =>
                '<div class="marker-info">' + (m.label || 'Marker ' + (i+1)) + ': (' + m.x + ', ' + m.y + ')</div>'
            ).join('');
        }

        // Poll for markers from server
        async function pollMarkers() {
            try {
                const res = await fetch('/api/tap-verifier/markers');
                const data = await res.json();
                if (data.markers && JSON.stringify(data.markers) !== JSON.stringify(markers)) {
                    markers = data.markers;
                    drawMarkers();
                }
            } catch (err) {
                // Ignore
            }
        }

        // Clear markers
        async function clearMarkers() {
            try {
                await fetch('/api/tap-verifier/clear-markers', { method: 'POST' });
                markers = [];
                drawMarkers();
            } catch (err) {
                console.error('Failed to clear:', err);
            }
        }

        // Grid overlay functionality
        const gridOverlay = document.getElementById('gridOverlay');
        let gridVisible = false;

        function toggleGrid() {
            gridVisible = !gridVisible;
            if (gridVisible) {
                gridOverlay.classList.add('visible');
                createGrid();
            } else {
                gridOverlay.classList.remove('visible');
            }
        }

        function createGrid() {
            gridOverlay.innerHTML = '';
            const w = window.innerWidth;
            const h = window.innerHeight;

            // Calculate button grid boundaries
            // Grid: max-width 400px, centered, padding 20px, gap 16px, 3 columns
            const gridWidth = Math.min(400, w);
            const gridLeft = (w - gridWidth) / 2;
            const gridRight = gridLeft + gridWidth;
            const padding = 20;
            const gap = 16;
            const colWidth = (gridWidth - 2 * padding - 2 * gap) / 3;

            // Column positions (centers)
            const col1Center = gridLeft + padding + colWidth / 2;
            const col2Center = gridLeft + padding + colWidth + gap + colWidth / 2;
            const col3Center = gridLeft + padding + 2 * colWidth + 2 * gap + colWidth / 2;

            // Column boundaries
            const col1Left = gridLeft + padding;
            const col1Right = col1Left + colWidth;
            const col2Left = col1Right + gap;
            const col2Right = col2Left + colWidth;
            const col3Left = col2Right + gap;
            const col3Right = col3Left + colWidth;

            // Draw vertical lines at column boundaries
            const vLines = [
                { x: gridLeft, label: Math.round(gridLeft) },
                { x: col1Left, label: Math.round(col1Left) },
                { x: col1Center, label: Math.round(col1Center) + ' (C1)', isCenter: true },
                { x: col1Right, label: Math.round(col1Right) },
                { x: col2Left, label: Math.round(col2Left) },
                { x: col2Center, label: Math.round(col2Center) + ' (C2)', isCenter: true },
                { x: col2Right, label: Math.round(col2Right) },
                { x: col3Left, label: Math.round(col3Left) },
                { x: col3Center, label: Math.round(col3Center) + ' (C3)', isCenter: true },
                { x: col3Right, label: Math.round(col3Right) },
                { x: gridRight, label: Math.round(gridRight) }
            ];

            vLines.forEach((line, i) => {
                const div = document.createElement('div');
                div.className = 'grid-line-v';
                div.style.left = line.x + 'px';
                if (line.isCenter) {
                    div.style.background = 'rgba(0, 255, 0, 0.8)';
                    div.style.width = '2px';
                }
                gridOverlay.appendChild(div);

                // Label
                const label = document.createElement('div');
                label.className = 'grid-label';
                label.textContent = line.label;
                label.style.left = (line.x + 3) + 'px';
                label.style.top = (70 + (i % 3) * 14) + 'px';
                if (line.isCenter) label.style.color = '#00ff00';
                gridOverlay.appendChild(label);
            });

            // Horizontal lines every 50px with labels
            for (let y = 0; y <= h; y += 50) {
                const div = document.createElement('div');
                div.className = 'grid-line-h';
                div.style.top = y + 'px';
                if (y % 100 === 0) {
                    div.style.background = 'rgba(255, 255, 0, 0.8)';
                }
                gridOverlay.appendChild(div);

                if (y % 100 === 0) {
                    const label = document.createElement('div');
                    label.className = 'grid-label';
                    label.textContent = 'y=' + y;
                    label.style.left = '3px';
                    label.style.top = (y + 2) + 'px';
                    gridOverlay.appendChild(label);
                }
            }
        }

        // Recreate grid on resize
        window.addEventListener('resize', () => {
            if (gridVisible) createGrid();
        });

        // Start polling
        setInterval(pollMarkers, 500);
        pollMarkers();
    </script>
</body>
</html>`;
}

function createRequestHandler() {
    return async (req: IncomingMessage, res: ServerResponse) => {
        // Set CORS headers for browser access
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
            res.statusCode = 204;
            res.end();
            return;
        }

        const fullUrl = req.url ?? "/";
        const [urlPath, queryString] = fullUrl.split('?');
        const url = urlPath; // Path without query params
        const params = new URLSearchParams(queryString || '');

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
            if (url === "/tap-verifier") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderTapVerifier());
                return;
            }
            if (url === "/bundle-errors") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderBundleErrors());
                return;
            }
            if (url === "/repl") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderRepl());
                return;
            }
            if (url === "/component-tree") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderComponentTree());
                return;
            }
            if (url === "/globals") {
                res.setHeader("Content-Type", "text/html");
                res.end(renderGlobals());
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
            } else if (url === "/api/connection-status") {
                // Connection health API endpoint
                const states: Record<string, unknown> = {};
                const health: Record<string, unknown> = {};
                for (const [appKey] of connectedApps.entries()) {
                    const state = getAllConnectionStates().get(appKey);
                    const contextHealth = getContextHealth(appKey);
                    if (state) states[appKey] = state;
                    if (contextHealth) health[appKey] = contextHealth;
                }
                res.end(JSON.stringify({ states, health }, null, 2));
            } else if (url === "/api/execute" && req.method === "POST") {
                // REPL execute API endpoint
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        const { expression, awaitPromise = true } = data;
                        if (!expression || typeof expression !== 'string') {
                            res.end(JSON.stringify({ success: false, error: 'expression is required' }));
                            return;
                        }
                        const result = await executeInApp(expression, awaitPromise);
                        res.end(JSON.stringify(result, null, 2));
                    } catch (err) {
                        res.end(JSON.stringify({ success: false, error: String(err) }));
                    }
                });
                return;
            } else if (url === "/api/component-tree") {
                // Component tree API endpoint
                const maxDepth = parseInt(params.get('maxDepth') || '50', 10);
                const focusedOnly = params.get('focusedOnly') === 'true';
                const structureOnly = params.get('structureOnly') === 'true';
                const includeProps = params.get('includeProps') === 'true';
                try {
                    const result = await getComponentTree({
                        maxDepth,
                        focusedOnly,
                        structureOnly,
                        includeProps
                    });
                    res.end(JSON.stringify(result, null, 2));
                } catch (err) {
                    res.end(JSON.stringify({ success: false, error: String(err) }));
                }
            } else if (url === "/api/globals") {
                // Debug globals list API endpoint
                try {
                    const result = await listDebugGlobals();
                    res.end(JSON.stringify(result, null, 2));
                } catch (err) {
                    res.end(JSON.stringify({ success: false, error: String(err) }));
                }
            } else if (url.startsWith("/api/globals/")) {
                // Inspect specific global API endpoint
                const globalName = decodeURIComponent(url.replace("/api/globals/", ""));
                if (!globalName) {
                    res.end(JSON.stringify({ success: false, error: 'Global name required' }));
                } else {
                    try {
                        const result = await inspectGlobal(globalName);
                        res.end(JSON.stringify(result, null, 2));
                    } catch (err) {
                        res.end(JSON.stringify({ success: false, error: String(err) }));
                    }
                }
            } else if (url === "/api/tap-verifier/devices") {
                const platform = params.get('platform') || 'android';
                try {
                    if (platform === 'android') {
                        const result = await listAndroidDevices();
                        if (result.success && result.devices) {
                            const devices = result.devices.map(d => ({
                                id: d.id,
                                name: `${d.model || d.id} (${d.status})`
                            }));
                            res.end(JSON.stringify({ devices }));
                        } else {
                            res.end(JSON.stringify({ devices: [], error: result.error }));
                        }
                    } else {
                        const result = await listIOSSimulators();
                        if (result.success && result.simulators) {
                            const devices = result.simulators
                                .filter(s => s.state === 'Booted')
                                .map(s => ({
                                    id: s.udid,
                                    name: `${s.name} (${s.runtime})`
                                }));
                            res.end(JSON.stringify({ devices }));
                        } else {
                            res.end(JSON.stringify({ devices: [], error: result.error }));
                        }
                    }
                } catch (err) {
                    res.end(JSON.stringify({ devices: [], error: String(err) }));
                }
            } else if (url === "/api/tap-verifier/screen-size") {
                const platform = params.get('platform') || 'android';
                const deviceId = params.get('deviceId') || undefined;
                try {
                    if (platform === 'android') {
                        const result = await androidGetScreenSize(deviceId);
                        if (result.success && result.width && result.height) {
                            res.end(JSON.stringify({ width: result.width, height: result.height }));
                        } else {
                            res.end(JSON.stringify({ error: result.error || 'Failed to get screen size' }));
                        }
                    } else {
                        // iOS doesn't have a direct screen size function, use common sizes
                        // We'll get the actual size from the screenshot
                        res.end(JSON.stringify({ width: 390, height: 844, note: 'Default iPhone size. Load screenshot for actual dimensions.' }));
                    }
                } catch (err) {
                    res.end(JSON.stringify({ error: String(err) }));
                }
            } else if (url === "/api/tap-verifier/screenshot") {
                const platform = params.get('platform') || 'android';
                const deviceId = params.get('deviceId') || undefined;
                try {
                    if (platform === 'android') {
                        const result = await androidScreenshot(deviceId);
                        if (result.success && result.data) {
                            const base64 = result.data.toString('base64');
                            res.end(JSON.stringify({ success: true, image: base64 }));
                        } else {
                            res.end(JSON.stringify({ success: false, error: result.error || 'Failed to take screenshot' }));
                        }
                    } else {
                        const result = await iosScreenshot(undefined, deviceId);
                        if (result.success && result.data) {
                            const base64 = result.data.toString('base64');
                            res.end(JSON.stringify({ success: true, image: base64 }));
                        } else {
                            res.end(JSON.stringify({ success: false, error: result.error || 'Failed to take screenshot' }));
                        }
                    }
                } catch (err) {
                    res.end(JSON.stringify({ success: false, error: String(err) }));
                }
            } else if (url === "/api/tap-verifier/execute" && req.method === "POST") {
                // Parse POST body
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        const { platform, x, y, deviceId } = data;

                        if (typeof x !== 'number' || typeof y !== 'number') {
                            res.end(JSON.stringify({ success: false, error: 'x and y must be numbers' }));
                            return;
                        }

                        if (platform === 'android') {
                            const result = await androidTap(x, y, deviceId);
                            res.end(JSON.stringify({ success: result.success, error: result.error }));
                        } else {
                            const result = await iosTap(x, y, { udid: deviceId });
                            res.end(JSON.stringify({ success: result.success, error: result.error }));
                        }
                    } catch (err) {
                        res.end(JSON.stringify({ success: false, error: String(err) }));
                    }
                });
                return; // Important: return here since we're handling the response asynchronously
            } else if (url === "/api/tap-verifier/mark" && req.method === "POST") {
                // Add a marker to the tap verifier (agent can mark calculated coordinates)
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        const { x, y, label, color } = data;

                        if (typeof x !== 'number' || typeof y !== 'number') {
                            res.end(JSON.stringify({ success: false, error: 'x and y must be numbers' }));
                            return;
                        }

                        const marker: TapMarker = {
                            x,
                            y,
                            label: label || undefined,
                            color: color || undefined,
                            timestamp: Date.now()
                        };
                        tapVerifierMarkers.push(marker);

                        res.end(JSON.stringify({
                            success: true,
                            marker,
                            totalMarkers: tapVerifierMarkers.length
                        }));
                    } catch (err) {
                        res.end(JSON.stringify({ success: false, error: String(err) }));
                    }
                });
                return;
            } else if (url === "/api/tap-verifier/markers") {
                // Get all markers added by the agent
                res.end(JSON.stringify({ markers: tapVerifierMarkers }));
            } else if (url === "/api/tap-verifier/clear-markers" && req.method === "POST") {
                // Clear all agent-added markers
                tapVerifierMarkers = [];
                res.end(JSON.stringify({ success: true, message: 'All markers cleared' }));
            } else if (url === "/api/ocr") {
                // OCR endpoint - takes screenshot and runs OCR
                const platform = params.get('platform') || 'ios';
                const deviceId = params.get('deviceId') || undefined;
                console.log(`[OCR] Request: platform=${platform}, deviceId=${deviceId || 'auto'}`);
                try {
                    // Take screenshot
                    let screenshotResult;
                    if (platform === 'android') {
                        screenshotResult = await androidScreenshot(deviceId);
                    } else {
                        screenshotResult = await iosScreenshot(undefined, deviceId);
                    }

                    if (!screenshotResult.success || !screenshotResult.data) {
                        console.log(`[OCR] Screenshot failed: ${screenshotResult.error || 'No image data'}`);
                        res.end(JSON.stringify({
                            success: false,
                            error: `Screenshot failed: ${screenshotResult.error || 'No image data'}`
                        }));
                        return;
                    }
                    // Infer device pixel ratio from screenshot dimensions (iOS only)
                    const devicePixelRatio = platform === 'ios' && screenshotResult.originalWidth && screenshotResult.originalHeight
                        ? inferIOSDevicePixelRatio(screenshotResult.originalWidth, screenshotResult.originalHeight)
                        : 1; // Android uses raw pixels

                    console.log(`[OCR] Screenshot captured, size=${screenshotResult.data.length} bytes, scaleFactor=${screenshotResult.scaleFactor}, devicePixelRatio=${devicePixelRatio}`);

                    // Run OCR with scale factor, platform, and device pixel ratio
                    const scaleFactor = screenshotResult.scaleFactor || 1;
                    const ocrResult = await recognizeText(screenshotResult.data, {
                        scaleFactor,
                        platform: platform as "ios" | "android",
                        devicePixelRatio
                    });

                    console.log(`[OCR] Complete: engine=${ocrResult.engine}, words=${ocrResult.words.length}, time=${ocrResult.processingTimeMs}ms`);

                    res.end(JSON.stringify({
                        success: ocrResult.success,
                        platform,
                        engine: ocrResult.engine || "unknown",
                        processingTimeMs: ocrResult.processingTimeMs,
                        fullText: ocrResult.fullText,
                        confidence: ocrResult.confidence,
                        wordsCount: ocrResult.words.length,
                        linesCount: ocrResult.lines.length,
                        words: ocrResult.words,
                        lines: ocrResult.lines,
                        imageScaleFactor: scaleFactor,
                        devicePixelRatio
                    }, null, 2));
                } catch (err) {
                    console.log(`[OCR] Error: ${err}`);
                    res.end(JSON.stringify({ success: false, error: String(err) }));
                }
            } else if (url === "/api" || url === "/api/") {
                const endpoints = {
                    message: "React Native AI Debugger - Debug HTTP Server",
                    html: {
                        "/": "Dashboard",
                        "/logs": "Console logs (colored)",
                        "/network": "Network requests",
                        "/bundle-errors": "Bundle/compilation errors",
                        "/apps": "Connected apps with connection health",
                        "/repl": "JavaScript REPL for code execution",
                        "/component-tree": "React component tree viewer",
                        "/globals": "Debug globals explorer",
                        "/tap-verifier": "Tap coordinate verification tool"
                    },
                    api: {
                        "/api/status": "Overall server status and buffer sizes",
                        "/api/logs": "All captured console logs (JSON)",
                        "/api/network": "All captured network requests (JSON)",
                        "/api/bundle-errors": "Metro bundle/compilation errors (JSON)",
                        "/api/apps": "Connected React Native apps (JSON)",
                        "/api/connection-status": "Connection states and context health for all apps",
                        "/api/execute": "Execute JavaScript in the app (POST: expression, awaitPromise?)",
                        "/api/component-tree": "Get React component tree (query: maxDepth, focusedOnly, structureOnly, includeProps)",
                        "/api/globals": "List available debug globals",
                        "/api/globals/:name": "Inspect a specific global object",
                        "/api/tap-verifier/devices": "List available devices (query: platform=android|ios)",
                        "/api/tap-verifier/screen-size": "Get device screen size (query: platform, deviceId)",
                        "/api/tap-verifier/screenshot": "Get device screenshot as base64 (query: platform, deviceId)",
                        "/api/tap-verifier/execute": "Execute tap at coordinates (POST: platform, x, y, deviceId)",
                        "/api/tap-verifier/mark": "Add a marker to visualize agent-calculated coordinates (POST: x, y, label?, color?)",
                        "/api/tap-verifier/markers": "Get all agent-added markers (GET)",
                        "/api/tap-verifier/clear-markers": "Clear all agent-added markers (POST)",
                        "/api/ocr": "Take screenshot and run OCR to extract text with coordinates (query: platform=ios|android, deviceId?)"
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
