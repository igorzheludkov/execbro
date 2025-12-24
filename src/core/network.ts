import { NetworkRequest } from "./types.js";

// Circular buffer for storing network requests
export class NetworkBuffer {
    private requests: Map<string, NetworkRequest> = new Map();
    private order: string[] = [];
    private maxSize: number;

    constructor(maxSize: number = 500) {
        this.maxSize = maxSize;
    }

    // Add or update a request
    set(requestId: string, request: NetworkRequest): void {
        if (!this.requests.has(requestId)) {
            this.order.push(requestId);
            if (this.order.length > this.maxSize) {
                const oldestId = this.order.shift();
                if (oldestId) {
                    this.requests.delete(oldestId);
                }
            }
        }
        this.requests.set(requestId, request);
    }

    // Get a request by ID
    get(requestId: string): NetworkRequest | undefined {
        return this.requests.get(requestId);
    }

    // Get all requests (optionally filtered)
    getAll(options: {
        count?: number;
        method?: string;
        urlPattern?: string;
        status?: number;
        completedOnly?: boolean;
    } = {}): NetworkRequest[] {
        const { count, method, urlPattern, status, completedOnly } = options;

        let results = Array.from(this.requests.values());

        // Sort by timestamp
        results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        if (method && method.trim()) {
            results = results.filter((r) => r.method.toUpperCase() === method.toUpperCase());
        }

        if (urlPattern && urlPattern.trim()) {
            const pattern = urlPattern.toLowerCase();
            results = results.filter((r) => r.url.toLowerCase().includes(pattern));
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
            .filter((r) => r.url.toLowerCase().includes(pattern))
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
        return count;
    }

    get size(): number {
        return this.requests.size;
    }
}

// Format a single request for display
export function formatRequest(request: NetworkRequest): string {
    const time = request.timestamp.toLocaleTimeString();
    const status = request.status ?? "pending";
    const duration = request.timing?.duration ? `${request.timing.duration}ms` : "-";

    let line = `[${request.requestId}] ${time} ${request.method} ${status} ${duration} ${request.url}`;

    if (request.error) {
        line += ` [ERROR: ${request.error}]`;
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

// Format request details (full info)
export function formatRequestDetails(request: NetworkRequest): string {
    const lines: string[] = [];

    lines.push(`=== ${request.method} ${request.url} ===`);
    lines.push(`Request ID: ${request.requestId}`);
    lines.push(`Time: ${request.timestamp.toISOString()}`);
    lines.push(`Status: ${request.status ?? "pending"} ${request.statusText ?? ""}`);

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

    // Request headers
    if (Object.keys(request.headers).length > 0) {
        lines.push("\n--- Request Headers ---");
        for (const [key, value] of Object.entries(request.headers)) {
            lines.push(`${key}: ${value}`);
        }
    }

    // Post data
    if (request.postData) {
        lines.push("\n--- Request Body ---");
        lines.push(request.postData);
    }

    // Response headers
    if (request.responseHeaders && Object.keys(request.responseHeaders).length > 0) {
        lines.push("\n--- Response Headers ---");
        for (const [key, value] of Object.entries(request.responseHeaders)) {
            lines.push(`${key}: ${value}`);
        }
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
): { requests: NetworkRequest[]; formatted: string } {
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
        formatted: formatRequests(requests)
    };
}

// Search network requests with formatting
export function searchNetworkRequests(
    networkBuffer: NetworkBuffer,
    urlPattern: string,
    maxResults: number = 50
): { requests: NetworkRequest[]; formatted: string } {
    const requests = networkBuffer.search(urlPattern, maxResults);
    return {
        requests,
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
