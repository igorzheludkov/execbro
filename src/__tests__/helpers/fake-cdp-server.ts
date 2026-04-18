import { WebSocketServer, WebSocket } from "ws";

interface CDPResponse {
    result?: {
        result?: {
            type: string;
            value?: unknown;
            subtype?: string;
            description?: string;
        };
        exceptionDetails?: {
            exceptionId: number;
            text: string;
            lineNumber: number;
            columnNumber: number;
            exception?: {
                type: string;
                subtype?: string;
                className?: string;
                description?: string;
                value?: unknown;
            };
        };
    };
    error?: {
        message: string;
        code?: number;
    };
}

type ResponseHandler = (params: Record<string, unknown>) => CDPResponse | null;

export class FakeCDPServer {
    private server: WebSocketServer | null = null;
    private connections: WebSocket[] = [];
    private evaluateHandler: ResponseHandler | null = null;
    private _receivedMessages: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
    port = 0;

    async start(): Promise<number> {
        return new Promise((resolve) => {
            this.server = new WebSocketServer({ port: 0 }, () => {
                this.port = (this.server!.address() as { port: number }).port;
                resolve(this.port);
            });

            this.server.on("connection", (ws) => {
                this.connections.push(ws);
                ws.on("message", (data) => {
                    const msg = JSON.parse(data.toString());
                    this._receivedMessages.push(msg);
                    this.handleMessage(ws, msg);
                });
                ws.on("close", () => {
                    this.connections = this.connections.filter((c) => c !== ws);
                });
            });
        });
    }

    private handleMessage(ws: WebSocket, msg: { id: number; method: string; params?: Record<string, unknown> }): void {
        // Auto-respond to domain enable messages
        if (msg.method === "Runtime.enable" || msg.method === "Log.enable" || msg.method === "Network.enable") {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
            return;
        }

        // Always answer the liveness probe correctly so connectToDevice can proceed.
        // The probe sends `1+1` with returnByValue; treat any such request as live.
        if (msg.method === "Runtime.evaluate") {
            const expr = (msg.params?.expression as string | undefined) ?? "";
            if (expr === "1+1") {
                ws.send(JSON.stringify({
                    id: msg.id,
                    result: { result: { type: "number", value: 2 } }
                }));
                return;
            }
        }

        // Handle Runtime.evaluate with custom handler
        if (msg.method === "Runtime.evaluate") {
            if (this.evaluateHandler) {
                const response = this.evaluateHandler(msg.params || {});
                // If handler returns null, don't send a response (simulates timeout)
                if (response !== null) {
                    ws.send(JSON.stringify({ id: msg.id, ...response }));
                }
            } else {
                // Default: return undefined
                ws.send(JSON.stringify({
                    id: msg.id,
                    result: { result: { type: "undefined" } },
                }));
            }
            return;
        }
    }

    /** Set a handler for Runtime.evaluate — receives params, returns CDP response shape */
    onEvaluate(handler: ResponseHandler): void {
        this.evaluateHandler = handler;
    }

    /** Convenience: respond with a successful value */
    respondWithValue(value: unknown, type = "object"): void {
        this.onEvaluate(() => ({
            result: { result: { type, value } },
        }));
    }

    /** Convenience: respond with a JS exception */
    respondWithError(errorType: string, message: string): void {
        this.onEvaluate(() => ({
            result: {
                exceptionDetails: {
                    exceptionId: 1,
                    text: "Uncaught",
                    lineNumber: 0,
                    columnNumber: 0,
                    exception: {
                        type: "object",
                        subtype: "error",
                        className: errorType,
                        description: `${errorType}: ${message}`,
                    },
                },
            },
        }));
    }

    /** Convenience: don't respond (causes timeout) */
    respondWithTimeout(): void {
        // Set a handler that returns null — handleMessage skips sending
        this.onEvaluate(() => null);
    }

    /** Get all received messages */
    get receivedMessages() {
        return this._receivedMessages;
    }

    /** Get the WebSocket URL for connecting as a device */
    get wsUrl(): string {
        return `ws://localhost:${this.port}`;
    }

    async stop(): Promise<void> {
        for (const ws of this.connections) {
            ws.close();
        }
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
