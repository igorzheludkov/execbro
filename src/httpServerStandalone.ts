#!/usr/bin/env node
/**
 * Standalone HTTP Debug Server
 * Can be run independently and hot-reloaded without restarting the MCP session
 */

import { startDebugHttpServer } from "./core/index.js";

const PORT = parseInt(process.env.DEBUG_SERVER_PORT || "9876", 10);

console.log(`[HTTP Server] Starting standalone debug server on port ${PORT}...`);

startDebugHttpServer({ port: PORT })
    .then((actualPort) => {
        console.log(`[HTTP Server] Running at http://localhost:${actualPort}`);
        console.log(`[HTTP Server] Ready for hot-reload. Restart this process to apply changes.`);

        // Send port to parent process if spawned
        if (process.send) {
            process.send({ type: "ready", port: actualPort });
        }
    })
    .catch((err) => {
        console.error(`[HTTP Server] Failed to start:`, err);
        process.exit(1);
    });

// Handle graceful shutdown
process.on("SIGTERM", () => {
    console.log(`[HTTP Server] Shutting down...`);
    process.exit(0);
});

process.on("SIGINT", () => {
    console.log(`[HTTP Server] Interrupted, shutting down...`);
    process.exit(0);
});
