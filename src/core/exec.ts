import { exec, execFile, ExecOptions } from "node:child_process";

export interface ExecAsyncOptions extends ExecOptions {
    signal?: AbortSignal;
}

/**
 * Argv-form process launcher — no shell, so nothing in `args` can be
 * interpreted as a shell metacharacter. This is the default for everything
 * this codebase runs (adb, xcrun, idb, axe, emulator): all of them are plain
 * command-plus-arguments, and building those as one string means every
 * interpolated tool parameter is a command-injection vector.
 *
 * Confirmed before this existed: `ios_open_url(url: 'myapp://x$(touch FILE)')`
 * created FILE on the host, because `exec` hands the assembled string to
 * `/bin/sh -c`. The parameters reaching these commands (URLs, bundle ids,
 * package names) are shaped by content the agent read out of the app under
 * test, so "the caller is trusted" does not hold.
 *
 * Same cancellation semantics as execAsync: SIGTERM on abort, SIGKILL 500ms
 * later, because a device-side `uiautomator dump` does not die with its host
 * ADB process.
 *
 * Use execAsync only when a real shell feature (pipe, redirect, heredoc) is
 * required AND no external input reaches the string.
 */
export function execFileAsync(
    file: string,
    args: string[],
    opts: ExecAsyncOptions = {}
): Promise<{ stdout: string; stderr: string }> {
    const { signal, ...execOpts } = opts;
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, execOpts, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        });
        const kill = () => {
            try { child.kill("SIGTERM"); } catch { /* already dead */ }
            setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* already dead */ }
            }, 500).unref();
        };
        if (signal) {
            if (signal.aborted) {
                kill();
                return;
            }
            signal.addEventListener("abort", kill, { once: true });
        }
    });
}

/**
 * Single-quote a value for the DEVICE-side shell in `adb shell <command>`.
 *
 * execFileAsync stops the host shell from seeing metacharacters, but `adb
 * shell` hands its command string to a shell on the device, which parses it
 * again. That second parse is a much smaller problem (it runs in the emulator,
 * not on the developer's machine) but it is still someone else's shell running
 * someone else's characters, so interpolated values get quoted there too.
 *
 * POSIX single-quoting: wrap in quotes and replace each embedded quote with
 * the '"'"' dance, since single quotes do not nest.
 */
export function quoteForDeviceShell(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Drop-in replacement for `promisify(exec)` that accepts an AbortSignal.
 * On abort, the child gets SIGTERM and then SIGKILL after 500ms — the
 * escalation matters for ADB calls like `uiautomator dump` whose device-side
 * process is independent of the host ADB process and may not exit on SIGTERM.
 */
export function execAsync(
    cmd: string,
    opts: ExecAsyncOptions = {}
): Promise<{ stdout: string; stderr: string }> {
    const { signal, ...execOpts } = opts;
    return new Promise((resolve, reject) => {
        const child = exec(cmd, execOpts, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        });
        const kill = () => {
            try { child.kill("SIGTERM"); } catch { /* already dead */ }
            setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* already dead */ }
            }, 500).unref();
        };
        if (signal) {
            if (signal.aborted) {
                kill();
                return;
            }
            signal.addEventListener("abort", kill, { once: true });
        }
    });
}

/**
 * Race an async operation against a timeout, with cancellation. The inner
 * factory receives an AbortSignal it can pass into execAsync, fetch, etc.
 * On timeout, the signal aborts so in-flight subprocesses get killed instead
 * of running on past the strategy cap.
 */
export function withCancelableTimeout<T>(
    make: (signal: AbortSignal) => Promise<T>,
    ms: number,
    label: string
): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return make(ctrl.signal).then(
        (val) => { clearTimeout(timer); return val; },
        (err) => {
            clearTimeout(timer);
            if (ctrl.signal.aborted) throw new Error(`${label} timed out after ${ms}ms`);
            throw err;
        }
    );
}
