#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";

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

import { registerAccountTools } from "./tools/accountTools.js";
import { registerMetaTools } from "./tools/metaTools.js";
import { registerReduxTools } from "./tools/reduxTools.js";
import { registerExecutionTools } from "./tools/executionTools.js";
import { registerLogTools } from "./tools/logTools.js";
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerBundleTools } from "./tools/bundleTools.js";
import { registerDeviceTools } from "./tools/deviceTools.js";
import { registerConnectionTools } from "./tools/connectionTools.js";
import { registerScreenshotTools } from "./tools/screenshotTools.js";
import { registerInteractionTools } from "./tools/interactionTools.js";
import { registerComponentTools } from "./tools/componentTools.js";

// Re-export so tests (src/__tests__/unit/toolDescriptions.test.ts) can enumerate
// registered tools without booting the server.
export { toolRegistry };

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
    httpMode: process.argv.includes("--http"),
});
registerReduxTools(server);
registerExecutionTools(server);
registerLogTools(server);
registerNetworkTools(server);
registerBundleTools(server);
registerDeviceTools(server);
registerConnectionTools(server);
registerScreenshotTools(server);
registerInteractionTools(server);
registerComponentTools(server);

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

    const useHttp = process.argv.includes("--http");
    const httpPort = parseInt(process.env.MCP_HTTP_PORT || "8600", 10);

    if (useHttp) {
        // HTTP transport mode — stateless for dev hot-reload
        // Stateless = no session IDs, so server restarts don't break Claude Code's connection
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        await server.connect(transport);

        const httpServer = createHttpServer(async (req, res) => {
            const url = new URL(req.url || "", `http://localhost:${httpPort}`);

            if (url.pathname === "/mcp") {
                await transport.handleRequest(req, res);
                return;
            }

            res.writeHead(404);
            res.end("Not found");
        });

        httpServer.listen(httpPort, () => {
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
