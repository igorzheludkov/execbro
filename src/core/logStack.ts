import { CDPStackFrame, LogEntry } from "./types.js";
import { StackFrame } from "./symbolicate.js";

/**
 * Capture-side handling of CDP stack traces attached to console events.
 *
 * Measured on device 2026-08-05 (React Native 0.83, Bridgeless, Hermes):
 * `Runtime.consoleAPICalled` carries a `stackTrace` at *every* level, including
 * `console.debug`. `Runtime.exceptionThrown` never fires — RN's global handler
 * turns uncaught throws and unhandled rejections into `console.error` — and
 * `Log.entryAdded` carries no stack at all. So this one event is the whole
 * capture surface.
 */

/**
 * Levels worth keeping a stack for. Every console event has one, and the
 * buffer holds 2000 entries; keeping frames on debug/log/info rows would spend
 * memory on lines nobody will ever ask to symbolicate. The network
 * interceptor's own `console.debug('__RN_NET__:…')` lines are the extreme case.
 */
const STACK_LEVELS: ReadonlySet<LogEntry["level"]> = new Set(["warn", "error", "fatal"]);

/**
 * Frames kept per entry. The top four are always RN/React internals (console
 * polyfill → react-devtools overrideMethod → ExceptionsManager → developer
 * tools), so this leaves room for real app depth below them.
 */
export const MAX_STORED_FRAMES = 12;

/**
 * Picks the frames worth storing for a log entry, or undefined when there is
 * nothing useful to keep. Never throws: a malformed stackTrace must not cost a
 * log line.
 */
export function captureStack(
    level: LogEntry["level"],
    stackTrace: unknown
): CDPStackFrame[] | undefined {
    if (!STACK_LEVELS.has(level)) return undefined;
    if (!stackTrace || typeof stackTrace !== "object") return undefined;

    const callFrames = (stackTrace as { callFrames?: unknown }).callFrames;
    if (!Array.isArray(callFrames) || callFrames.length === 0) return undefined;

    const out: CDPStackFrame[] = [];
    for (const raw of callFrames) {
        if (out.length >= MAX_STORED_FRAMES) break;
        if (!raw || typeof raw !== "object") continue;
        const f = raw as Record<string, unknown>;
        if (typeof f.lineNumber !== "number" || typeof f.columnNumber !== "number") continue;
        out.push({
            functionName: typeof f.functionName === "string" ? f.functionName : undefined,
            scriptId: typeof f.scriptId === "string" ? f.scriptId : undefined,
            url: typeof f.url === "string" && f.url.length > 0 ? f.url : undefined,
            lineNumber: f.lineNumber,
            columnNumber: f.columnNumber,
        });
    }

    return out.length > 0 ? out : undefined;
}

/**
 * Converts stored CDP frames into the shape Metro `/symbolicate` expects.
 *
 * **CDP line and column are 0-based; Metro wants 1-based.** Measured
 * 2026-08-05: posting `reactConsoleErrorHandler` as-is resolved to
 * ExceptionsManager.js:182 — the function *signature* — while `+1` resolved to
 * :184, `console._errorOriginal(...args)`, the actual call site. The as-is
 * answer is wrong by an amount small enough to look right in output. `+1` also
 * matches the 1-based frames parseStackString() produces, so both frame
 * sources agree.
 *
 * Frames with no `url` are dropped: they come from `Runtime.evaluate` sources
 * that Metro has no bundle entry for, so a request including them wastes a
 * round trip and returns nothing.
 */
export function toStackFrames(frames: readonly CDPStackFrame[]): StackFrame[] {
    const out: StackFrame[] = [];
    for (const f of frames) {
        if (!f.url) continue;
        out.push({
            file: f.url,
            lineNumber: f.lineNumber + 1,
            column: f.columnNumber + 1,
            methodName: f.functionName && f.functionName.length > 0 ? f.functionName : null,
        });
    }
    return out;
}
