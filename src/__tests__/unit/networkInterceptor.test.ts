import { describe, it, expect, beforeEach } from "@jest/globals";
import { NetworkBuffer } from "../../core/network.js";
import {
    isInterceptorEvent,
    applyInterceptedEvent,
} from "../../core/networkInterceptor.js";

describe("isInterceptorEvent", () => {
    it("returns JSON string for valid __RN_NET__ event", () => {
        const json = '{"type":"request","id":"js-ab12-1","method":"GET","url":"https://example.com"}';
        const args = [{ type: "string", value: `__RN_NET__:${json}` }];
        expect(isInterceptorEvent(args)).toBe(json);
    });

    it("returns null for regular console message", () => {
        const args = [{ type: "string", value: "Hello world" }];
        expect(isInterceptorEvent(args)).toBeNull();
    });

    it("returns null for non-string args", () => {
        const args = [{ type: "number", value: 42 }];
        expect(isInterceptorEvent(args)).toBeNull();
    });

    it("returns null for empty args", () => {
        expect(isInterceptorEvent([])).toBeNull();
    });
});

describe("applyInterceptedEvent", () => {
    let buffer: NetworkBuffer;

    beforeEach(() => {
        buffer = new NetworkBuffer(100);
    });

    it("request event creates a new entry in the buffer", () => {
        const json = JSON.stringify({
            type: "request",
            id: "js-ab12-1",
            method: "POST",
            url: "https://api.example.com/data",
            timestamp: 1700000000000,
        });

        applyInterceptedEvent(json, buffer);

        expect(buffer.size).toBe(1);
        const entry = buffer.get("js-ab12-1");
        expect(entry).toBeDefined();
        expect(entry!.method).toBe("POST");
        expect(entry!.url).toBe("https://api.example.com/data");
        expect(entry!.completed).toBe(false);
    });

    it("response event updates an existing entry", () => {
        // First create the request
        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id: "js-ab12-2",
                method: "GET",
                url: "https://api.example.com/users",
                timestamp: 1700000000000,
            }),
            buffer
        );

        // Then apply the response
        applyInterceptedEvent(
            JSON.stringify({
                type: "response",
                id: "js-ab12-2",
                status: 200,
                statusText: "OK",
                duration: 150,
            }),
            buffer
        );

        expect(buffer.size).toBe(1);
        const entry = buffer.get("js-ab12-2");
        expect(entry).toBeDefined();
        expect(entry!.status).toBe(200);
        expect(entry!.statusText).toBe("OK");
        expect(entry!.completed).toBe(true);
        expect(entry!.timing?.duration).toBe(150);
    });

    it("error event updates an existing entry", () => {
        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id: "js-ab12-3",
                method: "GET",
                url: "https://api.example.com/fail",
                timestamp: 1700000000000,
            }),
            buffer
        );

        applyInterceptedEvent(
            JSON.stringify({
                type: "error",
                id: "js-ab12-3",
                error: "Network request failed",
                duration: 50,
            }),
            buffer
        );

        expect(buffer.size).toBe(1);
        const entry = buffer.get("js-ab12-3");
        expect(entry).toBeDefined();
        expect(entry!.error).toBe("Network request failed");
        expect(entry!.completed).toBe(true);
        expect(entry!.timing?.duration).toBe(50);
    });

    it("invalid JSON is silently ignored", () => {
        applyInterceptedEvent("not valid json{{{", buffer);
        expect(buffer.size).toBe(0);
    });

    it("response without matching request is silently ignored", () => {
        applyInterceptedEvent(
            JSON.stringify({
                type: "response",
                id: "js-nonexistent-1",
                status: 200,
                statusText: "OK",
                duration: 100,
            }),
            buffer
        );

        expect(buffer.size).toBe(0);
    });
});
