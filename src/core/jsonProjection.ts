/**
 * Shape-first JSON projection for tool results.
 *
 * Slicing JSON by character is the worst available strategy: it destroys the
 * structure that makes a payload navigable while giving no signal about what
 * was dropped. `{"documentId":...,"data":{"approvals":...` tells a reader
 * nothing, least of all whether the field they came for exists.
 *
 * So: return the *shape* by default — every key path preserved, arrays and
 * objects annotated with their real sizes, leaves clipped short — and let a
 * caller that now knows where the bulk is pull one subtree in full with
 * `query`. Bounding is delegated to truncate.ts, which already walks values
 * cycle-safely against a byte target; this module adds the path language and
 * the miss handling on top.
 *
 * A query that matches nothing returns the shape summary, not an error. The
 * callers are LLMs emitting paths from memory, so wrong guesses are
 * inevitable, and turning a wasted round trip into progress is worth more than
 * being right about whose fault it was.
 */

import { truncateToBudget, DEFAULT_MAX_BYTES, type BudgetReport } from "./truncate.js";

const RENDER_INDENT = 2;

export interface ProjectJsonOptions {
    /** Dot-path into the value. Omit for the shape summary. */
    query?: string;
    /** Byte target for the rendered result. */
    maxBytes?: number;
}

export interface ProjectJsonResult {
    /** Rendered JSON — the projection when `query` matched, the shape otherwise. */
    text: string;
    /** False when a query was given and resolved to nothing. */
    matched: boolean;
    /** Why a query missed, and what is actually there. */
    note?: string;
    budget: BudgetReport;
}

export interface ProjectJsonTextResult extends ProjectJsonResult {
    /** False when the input was not JSON, so there was no structure to exploit. */
    isJson: boolean;
}

// ---------------------------------------------------------------------------
// Path language
//
// Dot-path with `[n]`, `[-n]`, `[*]` and `["quoted key"]`. Deliberately not
// JMESPath or jsonquery: no runtime dependency, no evaluation surface for
// model-generated strings, and it matches the `path` idiom redux_get_state
// already uses. A leading `$.` is stripped so a JSONPath emitted from memory
// still works rather than failing on its first character.
// ---------------------------------------------------------------------------

type Segment =
    | { kind: "key"; name: string }
    | { kind: "index"; index: number }
    | { kind: "wildcard" };

class QueryParseError extends Error {}

function parseBracket(body: string): Segment {
    const trimmed = body.trim();
    if (trimmed === "*") return { kind: "wildcard" };
    if (/^-?\d+$/.test(trimmed)) return { kind: "index", index: Number(trimmed) };
    const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
    if (quoted) return { kind: "key", name: quoted[2].replace(/\\(["'\\])/g, "$1") };
    if (trimmed.length === 0) throw new QueryParseError("empty [] — use [0], [-1], [*] or [\"key\"]");
    // A bare word inside brackets is a common shorthand; accept it as a key.
    return { kind: "key", name: trimmed };
}

function parseQuery(query: string): Segment[] {
    let s = query.trim();
    if (s.startsWith("$")) s = s.slice(1);

    const segments: Segment[] = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === ".") {
            i++;
            continue;
        }
        if (ch === "[") {
            let j = i + 1;
            let quote: string | null = null;
            while (j < s.length) {
                const c = s[j];
                if (quote) {
                    if (c === "\\") j++;
                    else if (c === quote) quote = null;
                } else if (c === "'" || c === '"') {
                    quote = c;
                } else if (c === "]") {
                    break;
                }
                j++;
            }
            if (j >= s.length) throw new QueryParseError("unclosed '['");
            segments.push(parseBracket(s.slice(i + 1, j)));
            i = j + 1;
            continue;
        }
        let j = i;
        while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
        const name = s.slice(i, j);
        if (name.length === 0) throw new QueryParseError(`unexpected '${ch}'`);
        segments.push({ kind: "key", name });
        i = j;
    }

    if (segments.length === 0) throw new QueryParseError("empty path");
    return segments;
}

function renderSegments(segments: Segment[], upTo: number): string {
    let out = "";
    for (let i = 0; i < upTo; i++) {
        const seg = segments[i];
        if (seg.kind === "key") out += out.length === 0 ? seg.name : `.${seg.name}`;
        else if (seg.kind === "index") out += `[${seg.index}]`;
        else out += "[*]";
    }
    return out.length === 0 ? "(root)" : out;
}

function renderSegment(seg: Segment): string {
    if (seg.kind === "key") return seg.name;
    if (seg.kind === "index") return `[${seg.index}]`;
    return "[*]";
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type Resolved = { ok: true; value: unknown } | { ok: false; depth: number; container: unknown };

function isPlainContainer(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveAt(value: unknown, segments: Segment[], i: number): Resolved {
    if (i >= segments.length) return { ok: true, value };
    const seg = segments[i];

    if (seg.kind === "wildcard") {
        const children = Array.isArray(value)
            ? value
            : isPlainContainer(value)
              ? Object.values(value)
              : null;
        if (children === null) return { ok: false, depth: i, container: value };

        const matches: unknown[] = [];
        let deepestFail: Resolved | null = null;
        for (const child of children) {
            const r = resolveAt(child, segments, i + 1);
            if (r.ok) matches.push(r.value);
            else if (!deepestFail || (!deepestFail.ok && r.depth > deepestFail.depth)) deepestFail = r;
        }
        if (matches.length > 0) return { ok: true, value: matches };
        return deepestFail ?? { ok: false, depth: i, container: value };
    }

    if (seg.kind === "index") {
        if (!Array.isArray(value)) return { ok: false, depth: i, container: value };
        const index = seg.index < 0 ? value.length + seg.index : seg.index;
        if (index < 0 || index >= value.length) return { ok: false, depth: i, container: value };
        return resolveAt(value[index], segments, i + 1);
    }

    if (!isPlainContainer(value) && !Array.isArray(value)) {
        return { ok: false, depth: i, container: value };
    }
    const obj = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg.name)) {
        return { ok: false, depth: i, container: value };
    }
    return resolveAt(obj[seg.name], segments, i + 1);
}

/** What is actually at the point a query gave up, so the retry is informed. */
function describeContainer(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return `an array of ${value.length}`;
    if (isPlainContainer(value)) {
        let keys: string[];
        try {
            keys = Object.keys(value);
        } catch {
            keys = [];
        }
        if (keys.length === 0) return "an empty object";
        const shown = keys.slice(0, 12).join(", ");
        const more = keys.length > 12 ? `, …+${keys.length - 12} more` : "";
        return `an object with keys: ${shown}${more}`;
    }
    return `a ${typeof value}`;
}

function missNote(query: string, segments: Segment[], fail: { depth: number; container: unknown }): string {
    const resolved = renderSegments(segments, fail.depth);
    const failed = renderSegment(segments[fail.depth]);
    const where = fail.depth === 0 ? "the root is" : `'${resolved}' is`;
    return (
        `query '${query}' matched nothing — ${where} ${describeContainer(fail.container)}, ` +
        `so '${failed}' is not there. Showing the shape instead; retry with a path from it.`
    );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function render(value: unknown, maxBytes: number): { text: string; budget: BudgetReport } {
    const result = truncateToBudget(value, maxBytes, undefined, RENDER_INDENT);
    const text = JSON.stringify(result.value, null, RENDER_INDENT) ?? "undefined";
    return {
        text,
        budget: {
            truncated: result.truncated,
            originalBytes: result.originalBytes,
            returnedBytes: text.length,
            appliedBudget: result.appliedBudget
        }
    };
}

export function projectJson(value: unknown, options: ProjectJsonOptions = {}): ProjectJsonResult {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const query = options.query?.trim();

    if (!query) {
        return { ...render(value, maxBytes), matched: true };
    }

    let segments: Segment[];
    try {
        segments = parseQuery(query);
    } catch (e) {
        const reason = e instanceof QueryParseError ? e.message : String(e);
        return {
            ...render(value, maxBytes),
            matched: false,
            note: `query '${query}' could not be parsed (${reason}). Use a dot-path like 'data.items[0].id' or 'errors[*].message'. Showing the shape instead.`
        };
    }

    const resolved = resolveAt(value, segments, 0);
    if (!resolved.ok) {
        return {
            ...render(value, maxBytes),
            matched: false,
            note: missNote(query, segments, resolved)
        };
    }

    return { ...render(resolved.value, maxBytes), matched: true };
}

/**
 * Same, for a result that reaches us already serialised.
 *
 * Non-JSON text has no structure to exploit, so it is clipped rather than
 * reshaped — and a query against it is reported as inapplicable rather than
 * silently ignored.
 */
export function projectJsonText(text: string, options: ProjectJsonOptions = {}): ProjectJsonTextResult {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const query = options.query?.trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        const clipped =
            text.length <= maxBytes
                ? text
                : text.slice(0, Math.max(0, maxBytes - 40)) + `…+${text.length - Math.max(0, maxBytes - 40)}`;
        return {
            text: clipped,
            isJson: false,
            matched: !query,
            note: query ? `query '${query}' was not applied — this body is not JSON.` : undefined,
            budget: {
                truncated: clipped.length !== text.length,
                originalBytes: text.length,
                returnedBytes: clipped.length,
                appliedBudget: null
            }
        };
    }

    // Text that already fits is returned byte-identical. Re-serialising it
    // would reflow a compact body into indented JSON purely as a side effect of
    // asking whether it needed bounding — and could push a body that fit over
    // the budget it was measured against.
    if (!query && text.length <= maxBytes) {
        return {
            text,
            isJson: true,
            matched: true,
            budget: { truncated: false, originalBytes: text.length, returnedBytes: text.length, appliedBudget: null }
        };
    }

    return { ...projectJson(parsed, { query, maxBytes }), isJson: true };
}

/**
 * The one-line footer the tools append. Kept here so every call site reports
 * bounding the same way — a reader who learns to read it once reads it
 * everywhere.
 */
export function formatProjectionNote(
    result: ProjectJsonResult,
    hint: string
): string | undefined {
    const parts: string[] = [];
    if (result.note) parts.push(result.note);
    if (result.budget.truncated) {
        const b = result.budget.appliedBudget;
        const shape = b
            ? `, depth<=${b.maxDepth}, arrays<=${b.maxArrayItems}, strings<=${b.maxStringLength}`
            : "";
        parts.push(
            `[bounded: ${result.budget.originalBytes} -> ${result.budget.returnedBytes} chars${shape}]\n${hint}`
        );
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
}
