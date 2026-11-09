import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { EventEmitter } from "events";
import WebSocket from "ws";
import { handleCDPMessage } from "../../core/connection.js";
import { connectedApps, getNetworkBuffer } from "../../core/state.js";
import type { DeviceInfo } from "../../core/types.js";

// CDP-only targets (RN 0.83+ Network domain, Electron) used to have no response
// body: the A2 benchmark agent saw a 422 with no reason and monkeypatched fetch
// through execute_in_app to read it. loadingFinished now asks for the body.

const device = { id: "d1", title: "RN", description: "", webSocketDebuggerUrl: "", deviceName: "BodyPhone" } as DeviceInfo;

function fakeWs(reply: (params: { requestId: string }) => Record<string, unknown>) {
    const ws = new EventEmitter() as unknown as WebSocket & EventEmitter;
    (ws as unknown as { readyState: number }).readyState = WebSocket.OPEN;
    (ws as unknown as { send: (s: string) => void }).send = (raw: string) => {
        const msg = JSON.parse(raw) as { id: number; method: string; params: { requestId: string } };
        if (msg.method !== "Network.getResponseBody") return;
        setImmediate(() => ws.emit("message", JSON.stringify({ id: msg.id, ...reply(msg.params) })));
    };
    return ws;
}

function run(ws: WebSocket, mimeType = "application/json") {
    handleCDPMessage({ method: "Network.requestWillBeSent", params: { requestId: "r1", request: { url: "http://x/carts/add", method: "POST", headers: {} } } }, device, ws);
    handleCDPMessage({ method: "Network.responseReceived", params: { requestId: "r1", response: { url: "http://x/carts/add", status: 422, statusText: "", headers: {}, mimeType } } }, device, ws);
    handleCDPMessage({ method: "Network.loadingFinished", params: { requestId: "r1" } }, device, ws);
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("CDP response bodies", () => {
    let errorSpy: ReturnType<typeof jest.spyOn>;
    beforeEach(() => {
        connectedApps.clear();
        getNetworkBuffer("BodyPhone").clear();
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => errorSpy.mockRestore());

    it("fetches the body of a textual response on loadingFinished", async () => {
        run(fakeWs(() => ({ result: { body: '{"error":"Validation failed"}', base64Encoded: false } })));
        await settle();
        expect(getNetworkBuffer("BodyPhone").get("r1")?.responseBody).toBe('{"error":"Validation failed"}');
    });

    it("decodes a base64 body", async () => {
        run(fakeWs(() => ({ result: { body: Buffer.from('{"ok":1}').toString("base64"), base64Encoded: true } })));
        await settle();
        expect(getNetworkBuffer("BodyPhone").get("r1")?.responseBody).toBe('{"ok":1}');
    });

    it("leaves binary responses and CDP errors alone", async () => {
        const asked: string[] = [];
        run(fakeWs((p) => { asked.push(p.requestId); return { result: { body: "x" } }; }), "image/png");
        await settle();
        expect(asked).toEqual([]);
        getNetworkBuffer("BodyPhone").clear();
        run(fakeWs(() => ({ error: { message: "No resource with given identifier" } })));
        await settle();
        expect(getNetworkBuffer("BodyPhone").get("r1")?.responseBody).toBeUndefined();
    });
});
