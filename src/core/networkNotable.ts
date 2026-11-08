/**
 * Turns captured traffic into findings an agent can act on. In the benchmark's T1 the
 * order body {"price":"9.99"} was printed in every run and named as a bug once: the
 * evidence was on screen, the comparison was not. Two checks, both worded as
 * "differs" or "says", never "wrong":
 *  - a key whose JSON type here differs from the single type it has in every other
 *    captured body on the same host;
 *  - a 4xx response's validation message.
 */

import type { NetworkRequest } from "./types.js";

const MAX_LINES = 3;
const SCAN_LAST = 200;
const MESSAGE_MAX = 120;

type JsonType = "string" | "number" | "boolean" | "object" | "array";

function parse(body?: string): unknown {
    if (!body) return undefined;
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

function typeOf(v: unknown): JsonType | null {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return "array";
    const t = typeof v;
    return t === "string" || t === "number" || t === "boolean" || t === "object" ? t : null;
}

/** key name -> types seen, at any depth, descending into arrays and objects. */
function collectTypes(v: unknown, into: Map<string, Set<JsonType>>, depth = 0): void {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
        for (const item of v) collectTypes(item, into, depth + 1);
        return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const t = typeOf(val);
        if (t) {
            let set = into.get(k);
            if (!set) into.set(k, (set = new Set()));
            set.add(t);
        }
        collectTypes(val, into, depth + 1);
    }
}

function hostOf(url: string): string | null {
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

function validationMessage(body: unknown): string | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    for (const k of ["message", "error", "detail"]) if (typeof b[k] === "string") return b[k] as string;
    if (Array.isArray(b.errors) && b.errors.length > 0) {
        const first = b.errors[0];
        if (typeof first === "string") return first;
        if (first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string") {
            return (first as { message: string }).message;
        }
    }
    return null;
}

export function notableLines(request: NetworkRequest, others: NetworkRequest[]): string[] {
    const lines: string[] = [];

    if (request.status !== undefined && request.status >= 400 && request.status < 500) {
        const msg = validationMessage(parse(request.responseBody));
        if (msg) lines.push(`${request.status} says "${msg.length > MESSAGE_MAX ? `${msg.slice(0, MESSAGE_MAX)}…` : msg}".`);
    }

    const host = hostOf(request.url);
    if (host) {
        const here = new Map<string, Set<JsonType>>();
        collectTypes(parse(request.postData), here);
        collectTypes(parse(request.responseBody), here);

        // key -> type -> number of other bodies it appeared in with that type
        const elsewhere = new Map<string, Map<JsonType, number>>();
        for (const o of others.slice(-SCAN_LAST)) {
            if (o.requestId === request.requestId || hostOf(o.url) !== host) continue;
            for (const body of [o.postData, o.responseBody]) {
                const seen = new Map<string, Set<JsonType>>();
                collectTypes(parse(body), seen);
                for (const [k, types] of seen) {
                    let m = elsewhere.get(k);
                    if (!m) elsewhere.set(k, (m = new Map()));
                    for (const t of types) m.set(t, (m.get(t) ?? 0) + 1);
                }
            }
        }

        for (const [k, types] of here) {
            if (types.size !== 1) continue;
            const mine = [...types][0];
            // Scalars only: a container key (JSON:API `data`) is legitimately an object on
            // a detail endpoint and an array on a list.
            if (mine === "object" || mine === "array") continue;
            const theirs = elsewhere.get(k);
            if (!theirs || theirs.size !== 1) continue;
            const [other, count] = [...theirs][0];
            if (other !== mine) lines.push(`"${k}" is a ${mine} here, a ${other} in ${count} other bodies on ${host}.`);
        }
    }

    return lines.slice(0, MAX_LINES);
}
