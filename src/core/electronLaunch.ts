/**
 * electron_launch_app: start an Electron project from source with its CDP port
 * open, the zero-config replacement for the one-line appendSwitch opt-in
 * (spec section 7).
 *
 * Only a source folder is ever launched, through the project's own electron or
 * electron-vite binary, so the app always runs unpackaged: app.isPackaged is
 * false by construction, and "never a CDP port on a packaged build" holds.
 * Chromium binds the port to 127.0.0.1.
 */
import { spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { DeviceInfo } from "./types.js";
import { fetchDevices, isChromiumTarget } from "./metro.js";
import { CONFIG_DIR } from "./paths.js";

export interface LaunchPlan { cmd: string; args: string[]; cwd: string; runner: "electron-vite" | "electron" }

const POLL_MS = 500;

/** node_modules/.bin/<name>, walking up from start, so a hoisted monorepo install is found. */
export function findBin(start: string, name: string): string | null {
    for (let dir = start; ; dir = dirname(dir)) {
        const p = join(dir, "node_modules", ".bin", name);
        if (existsSync(p)) return p;
        if (dirname(dir) === dir) return null;
    }
}

export function planElectronLaunch(projectPath: string, port: number): LaunchPlan | { error: string } {
    const cwd = resolve(projectPath);
    if (/\.(app|asar)(\/|$)/i.test(cwd)) {
        return { error: `${cwd} is a packaged build. execbro never opens a CDP port on a packaged app (anything that reaches the port could run code in it). Pass the project's source folder instead.` };
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { error: `${cwd} is not a directory. Pass the Electron project's source folder, the one with package.json.` };
    }
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) return { error: `No package.json in ${cwd}. Pass the Electron project's source folder.` };
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
        return { error: `${pkgPath} is not valid JSON.` };
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!deps.electron) return { error: `${pkg.name ?? cwd} does not depend on electron, so there is nothing to launch.` };
    const runner = deps["electron-vite"] ? "electron-vite" : "electron";
    const cmd = findBin(cwd, runner);
    if (!cmd) return { error: `${runner} is declared in package.json but not installed. Run npm install in ${cwd} first.` };
    return runner === "electron-vite"
        ? { cmd, args: ["dev", "--remoteDebuggingPort", String(port)], cwd, runner }
        : { cmd, args: [".", `--remote-debugging-port=${port}`], cwd, runner };
}

/**
 * The port Chromium actually opened. An app that calls
 * appendSwitch('remote-debugging-port', ...) overrides the flag, and Chromium
 * prints "DevTools listening on ws://127.0.0.1:<port>/..." either way.
 */
export function devToolsPortFromLog(log: string): number | null {
    const m = /DevTools listening on ws:\/\/[^:/]+:(\d+)\//.exec(log);
    return m ? Number(m[1]) : null;
}

function readLog(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

function tail(path: string, lines = 20): string {
    try {
        return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
        return "(no log)";
    }
}

export async function launchElectron(
    plan: LaunchPlan,
    port: number,
    timeoutMs: number,
    logDir: string = join(CONFIG_DIR, "electron")
): Promise<{ ok: true; pid: number; port: number; logPath: string; devices: DeviceInfo[] } | { ok: false; error: string; logPath: string }> {
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${basename(plan.cwd)}.log`);
    const fd = openSync(logPath, "w");
    const env = { ...process.env };
    // Exported in Claude Code's shell. With it, Electron boots as plain Node and
    // dies at the first app.* call, pointing at whatever line was edited last.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(plan.cmd, plan.args, { cwd: plan.cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    let exited: string | null = null;
    let spawnError: Error | null = null;
    child.on("exit", (code, signal) => { exited = String(code ?? signal); });
    child.on("error", (e) => { spawnError = e; });
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (spawnError) return { ok: false, error: `Could not start ${plan.cmd}: ${(spawnError as Error).message}`, logPath };
        if (exited !== null) {
            return { ok: false, error: `The app exited (${exited}) before its CDP port answered. Last log lines:\n${tail(logPath)}`, logPath };
        }
        const actual = devToolsPortFromLog(readLog(logPath)) ?? port;
        const devices = (await fetchDevices(actual)).filter(isChromiumTarget);
        if (devices.length > 0) return { ok: true, pid: child.pid!, port: actual, logPath, devices };
    }
    return {
        ok: false,
        error: `Port ${port} listed no window within ${Math.round(timeoutMs / 1000)}s. The app is still running (pid ${child.pid}). ` +
            `If its main process calls app.commandLine.appendSwitch('remote-debugging-port', ...), that port wins over this flag: ` +
            `connect_metro({ port: <that port> }), or relaunch with that port. Last log lines:\n${tail(logPath)}`,
        logPath,
    };
}
