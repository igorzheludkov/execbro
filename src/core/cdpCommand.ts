import type WebSocket from "ws";
import { getNextMessageId } from "./state.js";

/**
 * Send one CDP command and await its own response.
 *
 * The pendingExecutions path in handleCDPMessage formats every response as a
 * Runtime.evaluate RemoteObject, so any other domain (Page, Input) comes back as
 * "undefined" through it. This listens for its own id instead, the pattern
 * fetchObjectProperties already uses, and always detaches.
 */
export function sendCdpCommand<T = Record<string, unknown>>(
    ws: WebSocket,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = getNextMessageId();
        const finish = (settle: () => void) => {
            clearTimeout(timer);
            ws.removeListener("message", onMessage);
            settle();
        };
        const onMessage = (data: WebSocket.Data) => {
            let reply: { id?: number; result?: unknown; error?: { message?: string } };
            try {
                reply = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (reply.id !== id) return;
            const { error, result } = reply;
            finish(() =>
                error ? reject(new Error(`${method}: ${error.message ?? "CDP error"}`)) : resolve(result as T)
            );
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`))),
            timeoutMs
        );
        ws.on("message", onMessage);
        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
    });
}

/** Evaluate an expression that returns a JSON string, and parse it. */
export async function evaluateJson<T>(ws: WebSocket, expression: string, timeoutMs = 5000): Promise<T> {
    const r = await sendCdpCommand<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(ws, "Runtime.evaluate", { expression, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation threw");
    }
    return JSON.parse(String(r.result?.value)) as T;
}
