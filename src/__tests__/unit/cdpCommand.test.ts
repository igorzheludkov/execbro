import { describe, it, expect } from "@jest/globals";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { sendCdpCommand, evaluateJson } from "../../core/cdpCommand.js";

class FakeWs extends EventEmitter {
    sent: Array<{ id: number; method: string; params: unknown }> = [];
    send(s: string) { this.sent.push(JSON.parse(s)); }
    reply(msg: unknown) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}
const asWs = (f: FakeWs) => f as unknown as WebSocket;

describe("sendCdpCommand", () => {
    it("resolves with the result of the response carrying its own id, ignoring others", async () => {
        const ws = new FakeWs();
        const p = sendCdpCommand<{ data: string }>(asWs(ws), "Page.captureScreenshot", { format: "png" });
        const { id, method, params } = ws.sent[0];
        expect(method).toBe("Page.captureScreenshot");
        expect(params).toEqual({ format: "png" });
        ws.reply({ id: id + 1000, result: { data: "wrong" } });
        ws.reply({ method: "Runtime.consoleAPICalled", params: {} });
        ws.reply({ id, result: { data: "abc" } });
        await expect(p).resolves.toEqual({ data: "abc" });
        expect(ws.listenerCount("message")).toBe(0);
    });

    it("rejects with the CDP error message, naming the method", async () => {
        const ws = new FakeWs();
        const p = sendCdpCommand(asWs(ws), "Input.insertText", { text: "x" });
        ws.reply({ id: ws.sent[0].id, error: { code: -32000, message: "No focused element" } });
        await expect(p).rejects.toThrow("Input.insertText: No focused element");
        expect(ws.listenerCount("message")).toBe(0);
    });

    it("times out, and detaches its listener so a late reply is harmless", async () => {
        const ws = new FakeWs();
        const p = sendCdpCommand(asWs(ws), "Page.captureScreenshot", {}, 20);
        await expect(p).rejects.toThrow("Page.captureScreenshot timed out after 20ms");
        expect(ws.listenerCount("message")).toBe(0);
        ws.reply({ id: ws.sent[0].id, result: {} });
    });

    it("rejects when send throws (socket already closed)", async () => {
        const ws = new FakeWs();
        ws.send = () => { throw new Error("WebSocket is not open"); };
        await expect(sendCdpCommand(asWs(ws), "Page.captureScreenshot")).rejects.toThrow("WebSocket is not open");
        expect(ws.listenerCount("message")).toBe(0);
    });
});

describe("evaluateJson", () => {
    it("parses the JSON string the expression returns", async () => {
        const ws = new FakeWs();
        const p = evaluateJson<{ w: number }>(asWs(ws), "JSON.stringify({ w: 380 })");
        expect(ws.sent[0].params).toEqual({ expression: "JSON.stringify({ w: 380 })", returnByValue: true });
        ws.reply({ id: ws.sent[0].id, result: { result: { type: "string", value: "{\"w\":380}" } } });
        await expect(p).resolves.toEqual({ w: 380 });
    });

    it("throws the page exception's description", async () => {
        const ws = new FakeWs();
        const p = evaluateJson(asWs(ws), "boom()");
        ws.reply({ id: ws.sent[0].id, result: { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } } });
        await expect(p).rejects.toThrow("ReferenceError: boom is not defined");
    });
});
