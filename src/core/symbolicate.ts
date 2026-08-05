export interface StackFrame {
    file: string;
    lineNumber: number;
    column: number;
    methodName: string | null;
}

export interface SymbolicatedFrame {
    file: string;
    lineNumber: number;
    column: number;
    methodName: string | null;
    collapse: boolean;
}

// Matches Hermes/V8 frames:
//   "    at HomeScreen (http://host:8081/bundle?a=b:342013:64)"
//   "    at http://host:8081/bundle:100:5"
// The file group is greedy so the trailing ":line:col" anchors the match at the
// end — a lazy group would split on the colon inside "http://".
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.*):(\d+):(\d+)\)?\s*$/;

const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, SymbolicatedFrame>();

function cacheKey(frame: StackFrame): string {
    return `${frame.file}|${frame.lineNumber}|${frame.column}`;
}

export function clearSymbolicateCache(): void {
    cache.clear();
}

export function parseStackString(stack: string, limit = 5): StackFrame[] {
    if (!stack) return [];
    const out: StackFrame[] = [];
    for (const line of stack.split("\n")) {
        if (out.length >= limit) break;
        const m = FRAME_RE.exec(line);
        if (!m) continue;
        out.push({
            methodName: m[1] ?? null,
            file: m[2],
            lineNumber: Number(m[3]),
            column: Number(m[4]),
        });
    }
    return out;
}

/**
 * The topmost frame Metro did not mark `collapse`. On React Native every
 * console stack starts with four RN/React internals (the console polyfill,
 * react-devtools' overrideMethod, ExceptionsManager's reactConsoleErrorHandler,
 * setUpDeveloperTools) — measured 2026-08-05 — so this is what turns a stack
 * into the one line an agent actually wants. Unresolved frames are skipped.
 */
export function firstUserFrame(
    frames: (SymbolicatedFrame | null)[]
): SymbolicatedFrame | null {
    for (const frame of frames) {
        if (frame && !frame.collapse) return frame;
    }
    return null;
}

/**
 * Metro's /symbolicate endpoint. The `file` values are sent verbatim because
 * Metro matches them against its own bundle registry — rewriting them breaks
 * the lookup. Only the POST target is rewritten: the frames carry the LAN
 * address the device used, while execbro reaches Metro on loopback.
 */
function symbolicateEndpoint(file: string): string {
    try {
        const url = new URL(file);
        if (url.port) return `http://127.0.0.1:${url.port}/symbolicate`;
        return `${url.origin}/symbolicate`;
    } catch {
        return "http://127.0.0.1:8081/symbolicate";
    }
}

/**
 * Resolves bundle offsets to source locations via Metro.
 *
 * The result is **index-aligned with the input**: it always has `frames.length`
 * entries, and an entry Metro could not resolve is `null` rather than omitted.
 * Callers that only want the first user frame can ignore the nulls; callers
 * that pair frame N of the output with frame N of the input depend on it.
 *
 * Returns `null` (not an array) when the symbolicator itself is unreachable,
 * which callers must treat as "render raw", never as an error.
 */
export async function symbolicateFrames(
    frames: StackFrame[],
    timeoutMs = 10000
): Promise<(SymbolicatedFrame | null)[] | null> {
    if (frames.length === 0) return [];

    const results: (SymbolicatedFrame | null)[] = frames.map((f) => cache.get(cacheKey(f)) ?? null);
    const missingIndexes: number[] = [];
    results.forEach((r, i) => {
        if (r === null) missingIndexes.push(i);
    });

    if (missingIndexes.length === 0) return results;

    const endpoint = symbolicateEndpoint(frames[missingIndexes[0]].file);
    const payload = {
        stack: missingIndexes.map((i) => ({
            file: frames[i].file,
            lineNumber: frames[i].lineNumber,
            column: frames[i].column,
            methodName: frames[i].methodName,
        })),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { stack?: unknown[] };
        const returned = Array.isArray(body.stack) ? body.stack : [];

        missingIndexes.forEach((target, i) => {
            const raw = returned[i] as Record<string, unknown> | undefined;
            if (!raw) return;
            const resolved: SymbolicatedFrame = {
                file: String(raw.file ?? frames[target].file),
                lineNumber: Number(raw.lineNumber ?? frames[target].lineNumber),
                column: Number(raw.column ?? frames[target].column),
                methodName: (raw.methodName as string | null) ?? null,
                collapse: raw.collapse === true,
            };
            results[target] = resolved;
            if (cache.size >= MAX_CACHE_ENTRIES) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(cacheKey(frames[target]), resolved);
        });

        // Deliberately NOT filtered: dropping unresolved frames would shorten
        // the array and destroy index alignment with the input.
        return results;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
