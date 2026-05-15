import { exec, ExecOptions } from "node:child_process";

export interface ExecAsyncOptions extends ExecOptions {
    signal?: AbortSignal;
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
