import { describe, it, expect } from "@jest/globals";
import { WebSocketServer, WebSocket } from "ws";
import { probeCdpAlive } from "../../core/probe.js";

async function openPair(
    handler: (socket: WebSocket) => void
): Promise<{ wss: WebSocketServer; ws: WebSocket; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const addr = wss.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    wss.on("connection", handler);
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const close = () =>
        new Promise<void>((resolve) => {
            ws.close();
            wss.close(() => resolve());
        });
    return { wss, ws, close };
}

describe("probeCdpAlive", () => {
    it("resolves true when target replies with Runtime.evaluate result value 2", async () => {
        const { ws, close } = await openPair((socket) => {
            socket.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.method === "Runtime.evaluate") {
                    socket.send(
                        JSON.stringify({
                            id: msg.id,
                            result: { result: { type: "number", value: 2 } }
                        })
                    );
                }
            });
        });

        const alive = await probeCdpAlive(ws as unknown as WebSocket, 2000);
        expect(alive).toBe(true);
        await close();
    });

    it("resolves false when target never replies within timeout", async () => {
        const { ws, close } = await openPair(() => {
            // accept but never respond
        });

        const start = Date.now();
        const alive = await probeCdpAlive(ws as unknown as WebSocket, 300);
        const elapsed = Date.now() - start;

        expect(alive).toBe(false);
        expect(elapsed).toBeGreaterThanOrEqual(280);
        expect(elapsed).toBeLessThan(1500);
        await close();
    });

    it("returns false when reply is present but value is unexpected", async () => {
        const { ws, close } = await openPair((socket) => {
            socket.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                socket.send(
                    JSON.stringify({
                        id: msg.id,
                        result: { result: { type: "undefined" } }
                    })
                );
            });
        });

        const alive = await probeCdpAlive(ws as unknown as WebSocket, 500);
        expect(alive).toBe(false);
        await close();
    });
});
