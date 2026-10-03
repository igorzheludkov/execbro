import { WebSocketServer, WebSocket } from "ws";

export const NO_REPLY = Symbol("no-reply");
export type FakeHandler = (method: string, params: Record<string, unknown>) => unknown;

export const HELLO = {
    protocolVersion: 1,
    sdkVersion: "0.1.0",
    package: "com.example.app",
    label: "Example",
    versionName: "1.0",
    capabilities: ["state", "command", "navigation"]
};

export function rpcError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

/** An in-process stand-in for execbro-sdk-android: a ws server speaking the native protocol. */
export async function startFakeSdk(handler: FakeHandler) {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const sockets: WebSocket[] = [];
    server.on("connection", (ws) => {
        sockets.push(ws);
        ws.on("message", (data) => {
            const req = JSON.parse(data.toString()) as { id: number; method: string; params?: Record<string, unknown> };
            try {
                const result = handler(req.method, req.params ?? {});
                if (result === NO_REPLY) return;
                ws.send(JSON.stringify({ id: req.id, result }));
            } catch (e) {
                const err = e as Error & { code?: string };
                ws.send(JSON.stringify({ id: req.id, error: { code: err.code ?? "THREW", message: err.message } }));
            }
        });
    });
    const port = (server.address() as { port: number }).port;
    return {
        port,
        url: `ws://127.0.0.1:${port}`,
        emit(method: string, params: unknown) {
            for (const s of sockets) s.send(JSON.stringify({ method, params }));
        },
        dropClients() {
            for (const s of sockets) s.terminate();
        },
        close(): Promise<void> {
            for (const s of sockets) s.terminate();
            return new Promise((resolve) => server.close(() => resolve()));
        }
    };
}
