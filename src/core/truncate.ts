export interface TruncateBudget {
    maxDepth: number;
    maxArrayItems: number;
    maxStringLength: number;
}

export interface TruncateResult {
    value: unknown;
    truncated: boolean;
    /** null when the value fit without any bounding. */
    appliedBudget: TruncateBudget | null;
    originalBytes: number;
    returnedBytes: number;
}

// Ordered loosest-to-tightest. The middle three are the budgets measured
// against AppC's live 1,625,530-byte contentApi slice, which they reduced
// to 28,806 / 10,486 / 7,746 bytes respectively.
const BUDGET_LADDER: TruncateBudget[] = [
    { maxDepth: 8, maxArrayItems: 50, maxStringLength: 1000 },
    { maxDepth: 6, maxArrayItems: 20, maxStringLength: 400 },
    { maxDepth: 6, maxArrayItems: 2, maxStringLength: 60 },
    { maxDepth: 4, maxArrayItems: 3, maxStringLength: 80 },
    { maxDepth: 3, maxArrayItems: 5, maxStringLength: 100 },
    { maxDepth: 2, maxArrayItems: 2, maxStringLength: 40 },
    { maxDepth: 1, maxArrayItems: 1, maxStringLength: 20 }
];

/**
 * Size of `value` as it will actually be rendered.
 *
 * `indent` must match the indentation the caller will serialise with —
 * pretty-printing inflates output substantially, so measuring compact JSON and
 * emitting indented JSON lets results exceed the budget they were bounded to.
 */
function byteLength(value: unknown, indent: number): number {
    try {
        const json = JSON.stringify(value, null, indent);
        return json === undefined ? 0 : json.length;
    } catch {
        // Circular or otherwise unserialisable — treat as over any budget so
        // the caller falls through to a bounded walk that handles cycles.
        return Number.MAX_SAFE_INTEGER;
    }
}

function bound(value: unknown, budget: TruncateBudget, depth: number, seen: Set<object>): unknown {
    if (value === null || value === undefined) return value;

    const type = typeof value;
    if (type === "string") {
        const s = value as string;
        if (s.length <= budget.maxStringLength) return s;
        return s.slice(0, budget.maxStringLength) + "…+" + (s.length - budget.maxStringLength);
    }
    if (type !== "object") {
        // Functions and symbols are not JSON values; name them rather than dropping.
        if (type === "function") return "[Function]";
        if (type === "symbol") return String(value);
        return value;
    }

    const obj = value as object;
    if (seen.has(obj)) return "[Circular]";

    if (Array.isArray(value)) {
        if (depth >= budget.maxDepth) return "[Array(" + value.length + ")]";
        seen.add(obj);
        const kept: unknown[] = value
            .slice(0, budget.maxArrayItems)
            .map((item) => bound(item, budget, depth + 1, seen));
        if (value.length > budget.maxArrayItems) {
            kept.push("…+" + (value.length - budget.maxArrayItems) + " more");
        }
        seen.delete(obj);
        return kept;
    }

    const keys = Object.keys(obj);
    if (depth >= budget.maxDepth) return "{Object(" + keys.length + " keys)}";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        out[key] = bound((obj as Record<string, unknown>)[key], budget, depth + 1, seen);
    }
    seen.delete(obj);
    return out;
}

/**
 * Bound `value` so its serialised form fits within `maxBytes`.
 *
 * A value that already fits is returned untouched — identity matters because
 * most reads are tiny (AppB's median redux read is 70 characters) and must
 * not be reshaped. Otherwise budgets are tried loosest-first so the caller
 * keeps as much structure as the target allows.
 */
export function truncateToBudget(
    value: unknown,
    maxBytes: number,
    explicit?: Partial<TruncateBudget>,
    indent: number = 0
): TruncateResult {
    const originalBytes = byteLength(value, indent);
    const hasExplicit = explicit !== undefined && Object.keys(explicit).length > 0;

    if (!hasExplicit && originalBytes <= maxBytes) {
        return { value, truncated: false, appliedBudget: null, originalBytes, returnedBytes: originalBytes };
    }

    if (hasExplicit) {
        const budget: TruncateBudget = { ...BUDGET_LADDER[0], ...explicit };
        const boundedValue = bound(value, budget, 0, new Set());
        const returnedBytes = byteLength(boundedValue, indent);
        return {
            value: boundedValue,
            truncated: returnedBytes !== originalBytes,
            appliedBudget: budget,
            originalBytes,
            returnedBytes
        };
    }

    let last: { value: unknown; budget: TruncateBudget; bytes: number } | null = null;
    for (const budget of BUDGET_LADDER) {
        const boundedValue = bound(value, budget, 0, new Set());
        const bytes = byteLength(boundedValue, indent);
        last = { value: boundedValue, budget, bytes };
        if (bytes <= maxBytes) break;
    }

    const chosen = last as { value: unknown; budget: TruncateBudget; bytes: number };
    return {
        value: chosen.value,
        truncated: true,
        appliedBudget: chosen.budget,
        originalBytes,
        returnedBytes: chosen.bytes
    };
}

export const DEFAULT_MAX_BYTES = 25000;

export interface BudgetReport {
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    appliedBudget: TruncateBudget | null;
}

/**
 * Bound an already-serialised tool result.
 *
 * Results reach us as strings: JSON for objects, a plain scalar rendering
 * otherwise. Re-parse JSON so bounding is structural — markers then carry real
 * array lengths and key counts, which is what lets a caller decide the next,
 * narrower read. Non-JSON text has no structure to exploit, so it is clipped.
 */
export function applyResultBudget(
    text: string,
    maxBytes: number = DEFAULT_MAX_BYTES,
    explicit?: Partial<TruncateBudget>
): { text: string; budget: BudgetReport } {
    const originalBytes = text.length;
    const hasExplicit = explicit !== undefined && Object.keys(explicit).length > 0;

    if (!hasExplicit && originalBytes <= maxBytes) {
        return {
            text,
            budget: { truncated: false, originalBytes, returnedBytes: originalBytes, appliedBudget: null }
        };
    }

    let parsed: unknown;
    let isJson = true;
    try {
        parsed = JSON.parse(text);
    } catch {
        isJson = false;
    }

    if (!isJson) {
        // Reserve room for the marker so the result still honours maxBytes.
        const keep = Math.max(0, maxBytes - 40);
        const clipped = text.slice(0, keep) + "…+" + (originalBytes - keep);
        return {
            text: clipped,
            budget: { truncated: true, originalBytes, returnedBytes: clipped.length, appliedBudget: null }
        };
    }

    // Measure at the same indentation we render with, or the ladder converges
    // on a size we never emit.
    const RENDER_INDENT = 2;
    const result = truncateToBudget(parsed, maxBytes, explicit, RENDER_INDENT);
    const rendered = JSON.stringify(result.value, null, RENDER_INDENT) ?? "";
    return {
        text: rendered,
        budget: {
            truncated: result.truncated,
            originalBytes,
            returnedBytes: rendered.length,
            appliedBudget: result.appliedBudget
        }
    };
}
