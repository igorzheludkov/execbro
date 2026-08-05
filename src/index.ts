#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type ServerResponse } from "node:http";

import { DECISION_TREE } from "./core/guides.js";
import { identifyIfDevMode, shutdownPostHog } from "./core/posthog.js";
import { getInstallationId, isDevMode, initTelemetry } from "./core/telemetry.js";
import {
    connectedApps,
    cancelAllReconnectionTimers,
    clearAllConnectionState,
    clearAllCDPMessageTimes,
    suppressReconnection,
    disconnectMetroBuildEvents,
} from "./core/index.js";
import { installToolRegistryInterceptor, toolRegistry } from "./core/register.js";
import { isPublishedBuild } from "./core/buildInfo.js";
import { createSerialQueue } from "./core/serialQueue.js";

import { registerAccountTools } from "./tools/accountTools.js";
import { registerMetaTools } from "./tools/metaTools.js";
import { registerReduxTools } from "./tools/reduxTools.js";
import { registerExecutionTools } from "./tools/executionTools.js";
import { registerLogTools } from "./tools/logTools.js";
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerRequestTools } from "./tools/requestTools.js";
import { registerNavigationTools } from "./tools/navigationTools.js";
import { registerBundleTools } from "./tools/bundleTools.js";
import { registerDeviceTools } from "./tools/deviceTools.js";
import { registerConnectionTools } from "./tools/connectionTools.js";
import { registerScreenshotTools } from "./tools/screenshotTools.js";
import { registerInteractionTools } from "./tools/interactionTools.js";
import { registerComponentTools } from "./tools/componentTools.js";

// Re-export so tests (src/__tests__/unit/toolDescriptions.test.ts) can enumerate
// registered tools without booting the server.
export { toolRegistry };

// The HTTP transport is a development-only convenience: it is unauthenticated,
// and it registers the `dev` meta-tool, which proxies calls to every tool in the
// registry. Published builds must never expose either, so --http is honoured
// only in a source checkout. main() exits non-zero when a published build is
// launched with the flag, rather than silently falling back to stdio.
const httpRequested = process.argv.includes("--http");
const httpAllowed = httpRequested && !isPublishedBuild();

const server = new McpServer(
    {
        name: "ExecBro (Mobile DevTools)",
        version: "1.0.0"
    },
    {
        instructions: [
            "React Native debugging MCP server.",
            "",
            DECISION_TREE,
            "",
            "Call get_usage_guide with no arguments for the same decision tree plus a summary of every guide."
        ].join("\n")
    }
);
installToolRegistryInterceptor(server);

registerAccountTools(server);
registerMetaTools(server, {
    devMode: isDevMode(),
    httpMode: httpAllowed,
});
registerReduxTools(server);
registerExecutionTools(server);
registerLogTools(server);
registerNetworkTools(server);
registerRequestTools(server);
registerNavigationTools(server);
registerBundleTools(server);
registerDeviceTools(server);
registerConnectionTools(server);
registerScreenshotTools(server);
registerInteractionTools(server);
registerComponentTools(server);

// How long a serialized /mcp request may wait for its response to drain before
// the queue moves on regardless. Only reached when the SDK leaves the stream
// open after handleRequest resolves — normally this settles immediately.
const RESPONSE_DRAIN_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Never hold the process open for a drain timer.
        timer.unref?.();
    });
}

/** Resolves once the response socket is closed. Already-closed resolves now. */
function responseClosed(res: ServerResponse): Promise<void> {
    if (res.closed) return Promise.resolve();
    return new Promise((resolve) => res.once("close", () => resolve()));
}

async function main() {
    initTelemetry();
    identifyIfDevMode(getInstallationId());

    // License validation is intentionally NOT pre-loaded here. It runs lazily on
    // first real tool use (see ensureLicense() in trackToolInvocation), so that a
    // bare MCP server boot that never invokes a tool does not hit the backend.
    // This keeps Firebase reads/writes proportional to Active Sessions
    // (session_start_ai_devtools) rather than Agent Sessions (session_start).
    // Trade-off: the per-tool usage gate has no usage data on the very first tool
    // call of a session and fails open for that single call — acceptable.

    if (httpRequested && !httpAllowed) {
        console.error(
            "[execbro] --http is a development transport (unauthenticated, exposes the `dev` meta-tool) " +
                "and is disabled in published builds. Use the default stdio transport."
        );
        process.exit(1);
    }

    const httpPort = parseInt(process.env.MCP_HTTP_PORT || "8600", 10);

    // Only one /mcp request may hold the shared McpServer at a time.
    const mcpQueue = createSerialQueue();

    if (httpAllowed) {
        // HTTP transport mode — stateless for dev hot-reload
        // Stateless = no session IDs, so server restarts don't break Claude Code's connection
        const httpServer = createHttpServer(async (req, res) => {
            const url = new URL(req.url || "", `http://localhost:${httpPort}`);

            if (url.pathname === "/mcp") {
                // Serialized: the transport is per-request but `server` is not,
                // and McpServer.connect() throws "Already connected to a
                // transport" if a second transport attaches before the first
                // detaches. Two overlapping /mcp requests used to crash the
                // process. Clients that issue one request at a time never
                // noticed; a client that pipelines (or fires a notification
                // without awaiting it) hit it immediately.
                await mcpQueue
                    .run(async () => {
                        // A transport PER REQUEST, not one for the process
                        // lifetime. The streamable-HTTP transport is single-use
                        // in current SDKs: a hoisted instance answers the first
                        // request and then fails every later one with a 500 and
                        // no log line. Verified against
                        // @modelcontextprotocol/sdk 1.30.0 — initialize
                        // succeeded, every subsequent call 500'd until the
                        // process restarted.
                        const transport = new StreamableHTTPServerTransport({
                            sessionIdGenerator: undefined,
                        });
                        // Registered before handleRequest so a client that
                        // disconnects mid-response cannot be missed.
                        const closed = responseClosed(res);
                        try {
                            await server.connect(transport);
                            await transport.handleRequest(req, res);
                            // Detaching while the SDK is still streaming would
                            // truncate the reply, so wait for the response to
                            // finish — but bounded, because a tool that never
                            // answers must not wedge every later request.
                            await Promise.race([closed, delay(RESPONSE_DRAIN_TIMEOUT_MS)]);
                        } finally {
                            await Promise.resolve(transport.close()).catch(() => {
                                /* connection already gone */
                            });
                        }
                    })
                    .catch((err: unknown) => {
                        console.error(`[execbro] /mcp request failed: ${String(err)}`);
                        if (!res.headersSent) {
                            res.writeHead(500, { "Content-Type": "application/json" });
                            res.end(
                                JSON.stringify({
                                    jsonrpc: "2.0",
                                    error: { code: -32603, message: "Internal server error" },
                                    id: null,
                                })
                            );
                        } else if (!res.writableEnded) {
                            res.end();
                        }
                    });
                return;
            }

            res.writeHead(404);
            res.end("Not found");
        });

        // Bind loopback explicitly: listen(port) with no host binds 0.0.0.0,
        // which puts an unauthenticated device-control surface on the LAN.
        httpServer.listen(httpPort, "127.0.0.1", () => {
            console.error(`[execbro] MCP HTTP server listening on http://localhost:${httpPort}/mcp`);
        });
    } else {
        // Stdio transport mode — default for production
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[execbro] Server started on stdio");
    }
}

// Skip boot when loaded by unit tests — tests import this module purely to
// enumerate `toolRegistry`. Jest sets JEST_WORKER_ID; EXECBRO_TEST_MODE
// (or legacy RN_AI_DEVTOOLS_TEST_MODE) is a manual escape hatch.
// Production + dev:mcp leave all unset and boot.
if (!process.env.EXECBRO_TEST_MODE && !process.env.RN_AI_DEVTOOLS_TEST_MODE && !process.env.JEST_WORKER_ID) {
    main().catch((error) => {
        console.error("[execbro] Fatal error:", error);
        process.exit(1);
    });
}

// Graceful shutdown: close CDP connections so the slot is freed for other sessions
function gracefulShutdown() {
    suppressReconnection();
    cancelAllReconnectionTimers();
    for (const [key, app] of connectedApps.entries()) {
        try {
            app.ws.close();
        } catch {
            // Ignore close errors during shutdown
        }
        connectedApps.delete(key);
    }
    disconnectMetroBuildEvents();
    clearAllConnectionState();
    clearAllCDPMessageTimes();
    shutdownPostHog().catch(() => {});
}

process.on("beforeExit", () => {
    shutdownPostHog().catch(() => {});
});

process.on("SIGINT", () => {
    gracefulShutdown();
    process.exit(0);
});

process.on("SIGTERM", () => {
    gracefulShutdown();
    process.exit(0);
});
