import { NetworkRequest } from "./types.js";
import { getEpoch } from "./state.js";
import {
    operationSuffix,
    operationDetailLine,
    operationSearchText
} from "./graphqlOperation.js";
import { projectJsonText, formatProjectionNote } from "./jsonProjection.js";

// Circular buffer for storing network requests
export class NetworkBuffer {
    private requests: Map<string, NetworkRequest> = new Map();
    private order: string[] = [];
    private maxSize: number;
    private deviceName?: string;
    private dropped = 0;

    /**
     * @param deviceName Used to resolve the current epoch for get() lookups.
     *   Omit for merged read buffers.
     */
    constructor(maxSize: number = 500, deviceName?: string) {
        this.maxSize = maxSize;
        this.deviceName = deviceName;
    }

    private key(epoch: number, requestId: string): string {
        return `${epoch}:${requestId}`;
    }

    // Add or update a request. Keyed by epoch so a post-restart request that
    // reuses an id does not clobber the pre-restart entry.
    set(requestId: string, request: NetworkRequest): void {
        const k = this.key(request.epoch, requestId);
        if (!this.requests.has(k)) {
            this.order.push(k);
            if (this.order.length > this.maxSize) {
                const oldestKey = this.order.shift();
                if (oldestKey) {
                    this.requests.delete(oldestKey);
                    this.dropped++;
                }
            }
        }
        this.requests.set(k, request);
    }

    // Get a request by id. Prefers the current epoch, then scans older ones so
    // get_request_details still resolves a pre-restart id.
    get(requestId: string, epoch?: number): NetworkRequest | undefined {
        const preferred = epoch ?? (this.deviceName ? getEpoch(this.deviceName) : 1);
        const direct = this.requests.get(this.key(preferred, requestId));
        if (direct) return direct;
        for (const req of this.requests.values()) {
            if (req.requestId === requestId) return req;
        }
        return undefined;
    }

    // Get all requests (optionally filtered)
    getAll(options: {
        count?: number;
        method?: string;
        urlPattern?: string;
        status?: number;
        completedOnly?: boolean;
        epoch?: number;
    } = {}): NetworkRequest[] {
        const { count, method, urlPattern, status, completedOnly, epoch } = options;

        let results = Array.from(this.requests.values());

        // Sort by timestamp
        results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        if (epoch != null) {
            results = results.filter((r) => r.epoch === epoch);
        }

        if (method && method.trim()) {
            results = results.filter((r) => r.method.toUpperCase() === method.toUpperCase());
        }

        if (urlPattern && urlPattern.trim()) {
            const pattern = urlPattern.toLowerCase();
            results = results.filter(
                (r) =>
                    r.url.toLowerCase().includes(pattern) ||
                    (operationSearchText(r.postData)?.includes(pattern) ?? false)
            );
        }

        if (status != null && typeof status === "number") {
            results = results.filter((r) => r.status === status);
        }

        if (completedOnly === true) {
            results = results.filter((r) => r.completed);
        }

        if (count != null && count > 0) {
            results = results.slice(-count);
        }

        return results;
    }

    // Search requests by URL
    search(urlPattern: string, maxResults: number = 50): NetworkRequest[] {
        const pattern = urlPattern.toLowerCase();
        const results = Array.from(this.requests.values())
            .filter(
                (r) =>
                    r.url.toLowerCase().includes(pattern) ||
                    (operationSearchText(r.postData)?.includes(pattern) ?? false)
            )
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        if (maxResults > 0) {
            return results.slice(-maxResults);
        }
        return results;
    }

    clear(): number {
        const count = this.requests.size;
        this.requests.clear();
        this.order = [];
        this.dropped = 0;
        return count;
    }

    get size(): number {
        return this.requests.size;
    }

    /** Entries evicted by the capacity cap since the last clear(). */
    get droppedCount(): number {
        return this.dropped;
    }
}

// Format a single request for display
export function formatRequest(request: NetworkRequest): string {
    const time = request.timestamp.toLocaleTimeString();
    const status = request.status ?? "pending";
    const duration = request.timing?.duration ? `${request.timing.duration}ms` : "-";

    // GraphQL calls all share one URL, so the operation name is the only thing
    // that tells two rows apart.
    let line = `[${request.requestId}] ${time} ${request.method} ${status} ${duration} ${request.url}${operationSuffix(request.postData)}`;

    if (request.error) {
        line += ` [ERROR: ${request.error}]`;
    }

    // Every read of this row must say the response was altered. An agent that
    // forgets a rule is live will otherwise debug a failure it caused itself.
    if (request.mocked) {
        line += ` [MOCK ${request.mockId ?? "?"}]`;
    }

    return line;
}

// Format requests for text output
export function formatRequests(requests: NetworkRequest[]): string {
    if (requests.length === 0) {
        return "No network requests captured yet.";
    }

    return requests.map(formatRequest).join("\n");
}

/**
 * Default byte target for a rendered body.
 *
 * Higher than the 500 that preceded it because the unit changed: 500
 * characters of head-of-string is a couple of keys, but 500 characters of
 * *structure* is barely the outermost object. 2000 is enough to show the key
 * paths of a typical GraphQL response, which is what makes the follow-up query
 * targetable.
 */
export const DEFAULT_BODY_BUDGET = 2000;

// Options for formatting request details
export interface FormatRequestDetailsOptions {
    /** Byte target for a bounded body render. 0 = unlimited. */
    maxBodyLength?: number;
    /** Disable all bounding. */
    verbose?: boolean;
    /** Dot-path into the JSON body — see jsonProjection. */
    query?: string;
}

/**
 * Render one body.
 *
 * JSON goes through the shape-first projection: a 40KB GraphQL response
 * clipped at 500 characters reads `{"documentId":...,"data":{"approvals":...`
 * and stops, which does not even reveal whether the field the caller came for
 * exists. Bounding structurally keeps every key path and states the sizes it
 * dropped. Non-JSON has no structure to exploit, so it keeps the plain clip.
 */
function renderBody(
    raw: string,
    opts: { maxBodyLength: number; verbose: boolean; query?: string; hint: string }
): string {
    if (opts.verbose && !opts.query) return raw;

    const maxBytes = opts.maxBodyLength > 0 ? opts.maxBodyLength : Number.MAX_SAFE_INTEGER;
    const projected = projectJsonText(raw, { query: opts.query, maxBytes: opts.verbose ? Number.MAX_SAFE_INTEGER : maxBytes });
    const note = formatProjectionNote(projected, opts.hint);
    return note ? `${projected.text}\n\n${note}` : projected.text;
}

// Format request details (full info)
export function formatRequestDetails(
    request: NetworkRequest,
    options: FormatRequestDetailsOptions = {}
): string {
    const { maxBodyLength = DEFAULT_BODY_BUDGET, verbose = false, query } = options;
    const lines: string[] = [];

    lines.push(`=== ${request.method} ${request.url} ===`);
    lines.push(`Request ID: ${request.requestId}`);
    lines.push(`Time: ${request.timestamp.toISOString()}`);
    lines.push(`Status: ${request.status ?? "pending"} ${request.statusText ?? ""}`);

    const opLine = operationDetailLine(request.postData, request.url);
    if (opLine) {
        lines.push(opLine);
    }

    if (request.timing?.duration) {
        lines.push(`Duration: ${request.timing.duration}ms`);
    }

    if (request.mimeType) {
        lines.push(`Content-Type: ${request.mimeType}`);
    }

    if (request.contentLength !== undefined) {
        lines.push(`Content-Length: ${request.contentLength}`);
    }

    if (request.error) {
        lines.push(`Error: ${request.error}`);
    }

    if (request.mocked) {
        lines.push(`Mocked by: ${request.mockId ?? "?"}`);
    }

    if (request.mockWarning) {
        lines.push(`Mock warning: ${request.mockWarning}`);
    }

    // Request headers
    if (Object.keys(request.headers).length > 0) {
        lines.push("\n--- Request Headers ---");
        for (const [key, value] of Object.entries(request.headers)) {
            lines.push(`${key}: ${value}`);
        }
    }

    // Post data. The query targets the response body when there is one — that
    // is where the bulk lives — and falls back to the request body otherwise,
    // so a query on a GET that never returned still lands somewhere useful.
    const queryTarget: "response" | "request" = request.responseBody ? "response" : "request";

    if (request.postData) {
        lines.push("\n--- Request Body ---");
        lines.push(renderBody(request.postData, {
            maxBodyLength,
            verbose,
            query: queryTarget === "request" ? query : undefined,
            hint: "Raise maxBodyLength, pass verbose:true, or query a narrower path."
        }));
    }

    // Response headers
    if (request.responseHeaders && Object.keys(request.responseHeaders).length > 0) {
        lines.push("\n--- Response Headers ---");
        for (const [key, value] of Object.entries(request.responseHeaders)) {
            lines.push(`${key}: ${value}`);
        }
    }

    // Response body (SDK mirror and the JS interceptor's XHR layer — CDP does not capture it)
    if (request.responseBody) {
        lines.push("\n--- Response Body ---");
        lines.push(renderBody(request.responseBody, {
            maxBodyLength,
            verbose,
            query: queryTarget === "response" ? query : undefined,
            hint: "Raise maxBodyLength, pass verbose:true, or query a narrower path."
        }));
    }

    return lines.join("\n");
}

// Get network requests with formatting
export function getNetworkRequests(
    networkBuffer: NetworkBuffer,
    options: {
        maxRequests?: number;
        method?: string;
        urlPattern?: string;
        status?: number;
    } = {}
): { requests: NetworkRequest[]; count: number; formatted: string } {
    const { maxRequests = 50, method, urlPattern, status } = options;
    const requests = networkBuffer.getAll({
        count: maxRequests,
        method,
        urlPattern,
        status,
        completedOnly: false
    });

    return {
        requests,
        count: requests.length,
        formatted: formatRequests(requests)
    };
}

// Search network requests with formatting
export function searchNetworkRequests(
    networkBuffer: NetworkBuffer,
    urlPattern: string,
    maxResults: number = 50
): { requests: NetworkRequest[]; count: number; formatted: string } {
    const requests = networkBuffer.search(urlPattern, maxResults);
    return {
        requests,
        count: requests.length,
        formatted: formatRequests(requests)
    };
}

// Get network stats
export function getNetworkStats(networkBuffer: NetworkBuffer): string {
    const requests = networkBuffer.getAll({});

    if (requests.length === 0) {
        return "No network requests captured yet.";
    }

    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byDomain: Record<string, number> = {};
    let totalDuration = 0;
    let completedCount = 0;
    let errorCount = 0;

    for (const req of requests) {
        // Count by method
        byMethod[req.method] = (byMethod[req.method] || 0) + 1;

        // Count by status
        if (req.status !== undefined) {
            const statusGroup = `${Math.floor(req.status / 100)}xx`;
            byStatus[statusGroup] = (byStatus[statusGroup] || 0) + 1;
        }

        // Count by domain
        try {
            const url = new URL(req.url);
            byDomain[url.hostname] = (byDomain[url.hostname] || 0) + 1;
        } catch {
            // Invalid URL, skip domain counting
        }

        // Duration stats
        if (req.timing?.duration) {
            totalDuration += req.timing.duration;
            completedCount++;
        }

        if (req.error) {
            errorCount++;
        }
    }

    const lines: string[] = [];
    lines.push(`Total requests: ${requests.length}`);
    lines.push(`Completed: ${completedCount}`);
    lines.push(`Errors: ${errorCount}`);

    if (completedCount > 0) {
        lines.push(`Avg duration: ${Math.round(totalDuration / completedCount)}ms`);
    }

    lines.push("\nBy Method:");
    for (const [method, count] of Object.entries(byMethod).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${method}: ${count}`);
    }

    lines.push("\nBy Status:");
    for (const [status, count] of Object.entries(byStatus).sort()) {
        lines.push(`  ${status}: ${count}`);
    }

    lines.push("\nBy Domain:");
    for (const [domain, count] of Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        lines.push(`  ${domain}: ${count}`);
    }

    return lines.join("\n");
}
