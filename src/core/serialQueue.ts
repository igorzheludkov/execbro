/**
 * A promise chain that runs tasks one at a time, in submission order.
 *
 * Exists for the dev HTTP transport. `McpServer.connect()` binds the server to
 * exactly one transport and throws `Already connected to a transport` if a
 * second attaches before the first detaches. The transport must still be
 * per-request (a hoisted one answers `initialize` and then 500s forever), so
 * two overlapping `/mcp` requests would race on the shared server and crash
 * the process. Serializing the requests removes the overlap without giving up
 * the per-request transport.
 */
export interface SerialQueue {
    /** Runs `task` after every previously enqueued task has settled. */
    run<T>(task: () => Promise<T>): Promise<T>;
    /** Tasks enqueued and not yet settled, including the running one. */
    readonly pending: number;
}

export function createSerialQueue(): SerialQueue {
    // Never rejects: each link swallows its own failure so one bad task cannot
    // wedge every later one. Callers still see their own rejection, because
    // `run` returns the un-swallowed promise.
    let tail: Promise<void> = Promise.resolve();
    let pending = 0;

    return {
        run<T>(task: () => Promise<T>): Promise<T> {
            pending++;
            const result = tail.then(task);
            tail = result.then(
                () => undefined,
                () => undefined
            );
            return result.finally(() => {
                pending--;
            });
        },
        get pending(): number {
            return pending;
        },
    };
}
