import { describe, it, expect } from "@jest/globals";
import { NetworkBuffer } from "../../core/network.js";
import { applyInterceptedEvent, settleSuppressedEvent } from "../../core/networkInterceptor.js";

// RN 0.85 never answers Network.enable, so CDP capture is only detected on the
// first requestWillBeSent. A request in flight at that moment is recorded by the
// JS interceptor AND by CDP; its interceptor completion then arrives suppressed.
// Before the fix that completion was dropped and the interceptor row stayed
// "pending" forever next to the completed CDP row (a tap's network-idle wait ran
// to its 3 s cap on it).
const DEV = "iPhone Air";
const T = 1_700_000_000_000;

function started(buf: NetworkBuffer) {
    applyInterceptedEvent(JSON.stringify({ type: "request", id: "js-qjn5-1", method: "GET", url: "http://localhost:8092/products/1", timestamp: T }), buf, DEV);
}
const response = JSON.stringify({ type: "response", id: "js-qjn5-1", status: 200, duration: 60 });

describe("settleSuppressedEvent", () => {
    it("drops the interceptor row when CDP recorded the same request", () => {
        const buf = new NetworkBuffer(500, DEV);
        started(buf);
        const row = buf.get("js-qjn5-1")!;
        buf.set("23184101", { requestId: "23184101", timestamp: new Date(T + 15), method: "GET", url: "http://localhost:8092/products/1", headers: {}, status: 200, completed: true, epoch: row.epoch, capturedBy: "cdp" });

        settleSuppressedEvent(response, buf, DEV);

        const rows = buf.getAll({});
        expect(rows.map((r) => r.requestId)).toEqual(["23184101"]);
        expect(rows.some((r) => !r.completed)).toBe(false);
    });

    it("completes the interceptor row when nothing else recorded the request", () => {
        const buf = new NetworkBuffer(500, DEV);
        started(buf);

        settleSuppressedEvent(response, buf, DEV);

        const row = buf.get("js-qjn5-1")!;
        expect(row.completed).toBe(true);
        expect(row.status).toBe(200);
    });

    it("ignores suppressed events with no interceptor row (new requests stay suppressed)", () => {
        const buf = new NetworkBuffer(500, DEV);
        settleSuppressedEvent(JSON.stringify({ type: "request", id: "js-x-2", method: "GET", url: "http://a/b", timestamp: T }), buf, DEV);
        settleSuppressedEvent(JSON.stringify({ type: "response", id: "js-x-2", status: 200 }), buf, DEV);
        expect(buf.getAll({})).toHaveLength(0);
    });

    it("does not pair with a CDP row for the same URL far apart in time", () => {
        const buf = new NetworkBuffer(500, DEV);
        started(buf);
        const row = buf.get("js-qjn5-1")!;
        buf.set("old", { requestId: "old", timestamp: new Date(T - 60_000), method: "GET", url: "http://localhost:8092/products/1", headers: {}, status: 200, completed: true, epoch: row.epoch, capturedBy: "cdp" });

        settleSuppressedEvent(response, buf, DEV);

        expect(buf.get("js-qjn5-1")!.completed).toBe(true);
        expect(buf.getAll({})).toHaveLength(2);
    });
});
