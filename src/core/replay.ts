import { NetworkBuffer } from "./network.js";
import { UserInputError } from "./errors.js";

export interface ReplayArgs {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

/**
 * Rebuilds a captured request so it can be re-issued.
 *
 * Overrides replace rather than merge — including `headers`, so a header
 * present on the original can actually be dropped. Merging would make removing
 * one impossible.
 */
export function buildReplayArgs(
    buffer: NetworkBuffer,
    requestId: string,
    overrides: {
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        body?: string;
    }
): ReplayArgs {
    const entry = buffer.get(requestId);
    if (!entry) {
        throw new UserInputError(
            `No captured request "${requestId}". Ids come from get_network_requests and are valid until the buffer rolls over or clear_network runs.`,
            "replay_unknown_request"
        );
    }
    return {
        method: overrides.method ?? entry.method,
        url: overrides.url ?? entry.url,
        headers: overrides.headers ?? entry.headers,
        body: overrides.body ?? entry.postData
    };
}
