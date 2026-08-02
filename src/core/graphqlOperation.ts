/**
 * GraphQL operation extraction.
 *
 * Every GraphQL call in an app posts to the same endpoint, so the URL says
 * nothing about which operation ran — a list of requests reads as an
 * undifferentiated column of `/graphql`. The operation name is already in the
 * captured request body: the GraphQL-over-HTTP request shape is
 * `{query, operationName?, variables?, extensions?}`, and the GraphQL grammar
 * names an operation as `(query|mutation|subscription) Name`.
 *
 * Derived at read time rather than stored, so it applies to requests captured
 * before this shipped and needs no change to NetworkRequest.
 */

export type GraphQLOperationType = "query" | "mutation" | "subscription";

export interface GraphQLOperation {
    /** null for an anonymous operation (shorthand `{ ... }`). */
    name: string | null;
    type: GraphQLOperationType;
    /** Present, and always >1, only for batched array bodies. */
    batchSize?: number;
}

// The operation keyword must start a token, so a field named `mutationLog`
// cannot be mistaken for a mutation.
const NAMED_OPERATION = /(?:^|[\s{}])(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/;
const LEADING_KEYWORD = /(?:^|[\s{}])(query|mutation|subscription)\b/;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
    return typeof v === "string" && v.trim().length > 0;
}

/**
 * A body is GraphQL if it carries a document, or if it names an operation
 * alongside the other request fields — Apollo persisted queries send
 * operationName + extensions and omit `query` entirely.
 *
 * This guard is what keeps ordinary JSON POSTs from being mislabeled.
 */
function looksLikeGraphQL(o: Record<string, unknown>): boolean {
    if (typeof o.query === "string") return true;
    return nonEmptyString(o.operationName) && ("variables" in o || "extensions" in o);
}

export function parseGraphQLOperation(postData: string | undefined): GraphQLOperation | null {
    if (!postData) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(postData);
    } catch {
        return null;
    }

    let batchSize: number | undefined;
    if (Array.isArray(parsed)) {
        if (parsed.length === 0) return null;
        batchSize = parsed.length;
        parsed = parsed[0];
    }

    if (!isRecord(parsed) || !looksLikeGraphQL(parsed)) return null;

    const doc = typeof parsed.query === "string" ? parsed.query : "";
    const named = doc ? NAMED_OPERATION.exec(doc) : null;

    let type: GraphQLOperationType = "query";
    if (named) {
        type = named[1] as GraphQLOperationType;
    } else if (doc) {
        const kw = LEADING_KEYWORD.exec(doc);
        if (kw) type = kw[1] as GraphQLOperationType;
    }

    const name = nonEmptyString(parsed.operationName)
        ? parsed.operationName.trim()
        : (named ? named[2] : null);

    const op: GraphQLOperation = { name, type };
    if (batchSize !== undefined && batchSize > 1) op.batchSize = batchSize;
    return op;
}

/** Human-facing label, e.g. "GetUser", "anonymous mutation", "A +2 more". */
export function formatOperationLabel(op: GraphQLOperation): string {
    const base = op.name ?? `anonymous ${op.type}`;
    if (op.batchSize && op.batchSize > 1) return `${base} +${op.batchSize - 1} more`;
    return base;
}
