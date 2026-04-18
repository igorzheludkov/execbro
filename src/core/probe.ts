import WebSocket from "ws";

let probeIdCounter = 1_000_000;
function nextProbeId(): number {
    return probeIdCounter++;
}

/**
 * Send a trivial Runtime.evaluate to verify the CDP target's JS context is alive.
 * Returns true when the remote replies with result.value === 2 within timeoutMs.
 * Returns false on timeout, parse error, unexpected payload, or socket error.
 *
 * Metro advertises stale/zombie CDP pages after the underlying device or app
 * goes away. The WebSocket handshake still completes on those targets, so this
 * extra JS-level probe is the only reliable way to distinguish live from dead.
 */
export async function probeCdpAlive(
    ws: WebSocket,
    timeoutMs: number
): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return false;

    const id = nextProbeId();
    const payload = JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression: "1+1", returnByValue: true }
    });

    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (alive: boolean) => {
            if (settled) return;
            settled = true;
            ws.off("message", onMessage);
            clearTimeout(timer);
            resolve(alive);
        };

        const onMessage = (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id !== id) return;
                const value = msg?.result?.result?.value;
                finish(value === 2);
            } catch {
                finish(false);
            }
        };

        const timer = setTimeout(() => finish(false), timeoutMs);

        ws.on("message", onMessage);
        try {
            ws.send(payload);
        } catch {
            finish(false);
        }
    });
}
