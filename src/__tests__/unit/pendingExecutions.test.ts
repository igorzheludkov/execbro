import { describe, it, expect, beforeEach } from "@jest/globals";
import { pendingExecutions, failPendingExecutionsForSocket } from "../../core/state.js";
import type { ExecutionResult } from "../../core/types.js";

// A socket death mid-flight used to leave the in-flight CDP call parked until
// its full timeoutMs elapsed (telemetry: 48 events/30d across 12 tools, burning
// the entire timeout — min durations sat exactly on 5001/10001/30007ms). Worse,
// the resulting "Timeout: Expression took too long" message was classified
// server-timer => logical, so auto-reconnect never fired. Failing the pending
// call at close time makes it surface as a ws_closed transport error instead.
describe("failPendingExecutionsForSocket", () => {
    beforeEach(() => {
        pendingExecutions.clear();
    });

    const register = (id: number, ws: unknown) => {
        const results: ExecutionResult[] = [];
        let cleared = false;
        const timeoutId = setTimeout(() => { /* no-op */ }, 60_000) as NodeJS.Timeout;
        const originalClear = clearTimeout;
        pendingExecutions.set(id, {
            resolve: (r: ExecutionResult) => { results.push(r); },
            timeoutId,
            ws,
        });
        return {
            results,
            isCleared: () => cleared,
            cleanup: () => originalClear(timeoutId),
        };
    };

    it("fails pending executions belonging to the closed socket", () => {
        const socket = { id: "a" };
        const entry = register(1, socket);

        const failed = failPendingExecutionsForSocket(socket, "WebSocket connection is not open.");

        expect(failed).toBe(1);
        expect(entry.results).toHaveLength(1);
        expect(entry.results[0].success).toBe(false);
        expect(entry.results[0].error).toBe("WebSocket connection is not open.");
        entry.cleanup();
    });

    it("removes the failed execution from the pending map", () => {
        const socket = { id: "a" };
        const entry = register(1, socket);

        failPendingExecutionsForSocket(socket, "WebSocket connection is not open.");

        expect(pendingExecutions.has(1)).toBe(false);
        entry.cleanup();
    });

    it("leaves executions belonging to other sockets untouched", () => {
        const socketA = { id: "a" };
        const socketB = { id: "b" };
        const a = register(1, socketA);
        const b = register(2, socketB);

        const failed = failPendingExecutionsForSocket(socketA, "WebSocket connection is not open.");

        expect(failed).toBe(1);
        expect(b.results).toHaveLength(0);
        expect(pendingExecutions.has(2)).toBe(true);
        a.cleanup();
        b.cleanup();
    });

    it("ignores entries with no socket association", () => {
        const socket = { id: "a" };
        const timeoutId = setTimeout(() => { /* no-op */ }, 60_000) as NodeJS.Timeout;
        const results: ExecutionResult[] = [];
        pendingExecutions.set(9, { resolve: (r: ExecutionResult) => { results.push(r); }, timeoutId });

        const failed = failPendingExecutionsForSocket(socket, "WebSocket connection is not open.");

        expect(failed).toBe(0);
        expect(results).toHaveLength(0);
        expect(pendingExecutions.has(9)).toBe(true);
        clearTimeout(timeoutId);
    });
});
