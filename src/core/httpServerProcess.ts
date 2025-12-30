/**
 * HTTP Server Process Manager
 * Manages the standalone HTTP server as a child process for hot-reload capability
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let httpServerProcess: ChildProcess | null = null;
let currentPort: number | null = null;
let isRestarting = false;
const DEFAULT_PORT = 9876;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Kill any orphaned httpServerStandalone processes
 */
function killOrphanedProcesses(): void {
    try {
        if (process.platform === "win32") {
            // Windows: use taskkill to find and kill node processes running httpServerStandalone
            execSync("taskkill /F /FI \"IMAGENAME eq node.exe\" /FI \"WINDOWTITLE eq *httpServerStandalone*\" 2>nul || exit 0", { stdio: "ignore" });
        } else {
            // macOS/Linux: use pkill
            execSync("pkill -f 'httpServerStandalone' 2>/dev/null || true", { stdio: "ignore" });
        }
    } catch {
        // Ignore errors - process may not exist
    }
}

/**
 * Start the HTTP server as a child process
 */
export async function startHttpServerProcess(preferredPort: number = DEFAULT_PORT): Promise<number> {
    // Always kill orphaned processes first (from previous sessions)
    killOrphanedProcesses();

    if (httpServerProcess) {
        console.log("[HTTP Process] Server already running, stopping first...");
        await stopHttpServerProcess();
    }

    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 500));

    return new Promise((resolve, reject) => {
        const serverScript = join(__dirname, "..", "httpServerStandalone.js");

        console.log(`[HTTP Process] Starting server process on port ${preferredPort}...`);

        httpServerProcess = spawn("node", [serverScript], {
            env: {
                ...process.env,
                DEBUG_SERVER_PORT: String(preferredPort)
            },
            stdio: ["pipe", "pipe", "pipe", "ipc"]
        });

        // Handle stdout
        httpServerProcess.stdout?.on("data", (data) => {
            const lines = data.toString().trim().split("\n");
            for (const line of lines) {
                console.log(line);
            }
        });

        // Handle stderr
        httpServerProcess.stderr?.on("data", (data) => {
            const lines = data.toString().trim().split("\n");
            for (const line of lines) {
                console.error(line);
            }
        });

        // Handle IPC messages from child
        httpServerProcess.on("message", (msg: { type: string; port?: number }) => {
            if (msg.type === "ready" && msg.port) {
                currentPort = msg.port;
                console.log(`[HTTP Process] Server ready on port ${currentPort}`);
                resolve(currentPort);
            }
        });

        // Handle process exit
        httpServerProcess.on("exit", (code) => {
            if (!isRestarting) {
                console.log(`[HTTP Process] Server exited with code ${code}`);
            }
            httpServerProcess = null;
        });

        // Handle errors
        httpServerProcess.on("error", (err) => {
            console.error(`[HTTP Process] Error:`, err);
            reject(err);
        });

        // Timeout if server doesn't start
        setTimeout(() => {
            if (!currentPort) {
                reject(new Error("HTTP server startup timeout"));
            }
        }, 10000);
    });
}

/**
 * Stop the HTTP server process
 */
export async function stopHttpServerProcess(): Promise<void> {
    if (!httpServerProcess) {
        return;
    }

    return new Promise((resolve) => {
        isRestarting = true;

        httpServerProcess!.on("exit", () => {
            httpServerProcess = null;
            currentPort = null;
            isRestarting = false;
            resolve();
        });

        httpServerProcess!.kill("SIGTERM");

        // Force kill after timeout
        setTimeout(() => {
            if (httpServerProcess) {
                httpServerProcess.kill("SIGKILL");
                httpServerProcess = null;
                currentPort = null;
                isRestarting = false;
                resolve();
            }
        }, 3000);
    });
}

/**
 * Restart the HTTP server (for hot-reload)
 */
export async function restartHttpServerProcess(): Promise<number> {
    // Preserve port before stopping (stopHttpServerProcess resets currentPort)
    const port = currentPort || DEFAULT_PORT;
    console.log(`[HTTP Process] Restarting server for hot-reload on port ${port}...`);

    // Kill orphaned processes first
    killOrphanedProcesses();

    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start fresh (don't call stopHttpServerProcess as we already killed everything)
    httpServerProcess = null;
    currentPort = null;
    isRestarting = false;

    return startHttpServerProcess(port);
}

/**
 * Get the current HTTP server port
 */
export function getHttpServerProcessPort(): number | null {
    return currentPort;
}

/**
 * Check if the HTTP server process is running
 */
export function isHttpServerProcessRunning(): boolean {
    return httpServerProcess !== null && !httpServerProcess.killed;
}
