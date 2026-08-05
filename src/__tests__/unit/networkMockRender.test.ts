import { describe, it, expect, beforeEach } from "@jest/globals";
import { NetworkBuffer, formatRequest, formatRequestDetails } from "../../core/network.js";
import { applyInterceptedEvent, isMockedTrafficEvent } from "../../core/networkInterceptor.js";
import { runWithMocks } from "../helpers/mock-harness.js";
import { addRule, listRules, __resetMockRules } from "../../core/mockRules.js";

/**
 * Silently altered traffic is the real hazard of a mock layer: an agent
 * debugging a phantom. A mock must never be invisible.
 */
describe("mocked request marking", () => {
    let buffer: NetworkBuffer;
    beforeEach(() => {
        buffer = new NetworkBuffer(100);
        __resetMockRules();
    });

    function seed(id: string) {
        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id,
                method: "GET",
                url: "https://api.example.com/orders",
            }),
            buffer,
            "dev"
        );
    }

    it("a mock event marks the entry with its rule id", () => {
        seed("js-1");
        applyInterceptedEvent(
            JSON.stringify({ type: "mock", id: "js-1", ruleId: "m1" }),
            buffer,
            "dev"
        );
        const e = buffer.get("js-1")!;
        expect(e.mocked).toBe(true);
        expect(e.mockId).toBe("m1");
    });

    it("stores a tamper warning", () => {
        seed("js-2");
        applyInterceptedEvent(
            JSON.stringify({
                type: "mock",
                id: "js-2",
                ruleId: "m1",
                warning: "tamper skipped - response was not JSON",
            }),
            buffer,
            "dev"
        );
        expect(buffer.get("js-2")!.mockWarning).toMatch(/not JSON/i);
    });

    it("renders a [MOCK id] tag on the row", () => {
        seed("js-3");
        applyInterceptedEvent(
            JSON.stringify({ type: "mock", id: "js-3", ruleId: "m7" }),
            buffer,
            "dev"
        );
        expect(formatRequest(buffer.get("js-3")!)).toContain("[MOCK m7]");
    });

    it("leaves an unmocked row byte-identical", () => {
        seed("js-4");
        expect(formatRequest(buffer.get("js-4")!)).not.toContain("MOCK");
    });

    it("surfaces the warning in the details view", () => {
        seed("js-5");
        applyInterceptedEvent(
            JSON.stringify({
                type: "mock",
                id: "js-5",
                ruleId: "m1",
                warning: "tamper skipped - response was not JSON",
            }),
            buffer,
            "dev"
        );
        const details = formatRequestDetails(buffer.get("js-5")!);
        expect(details).toContain("tamper skipped");
        expect(details).toContain("Mocked by: m1");
    });

    it("a mock event for an unknown id is silently ignored", () => {
        applyInterceptedEvent(
            JSON.stringify({ type: "mock", id: "js-gone", ruleId: "m1" }),
            buffer,
            "dev"
        );
        expect(buffer.size).toBe(0);
    });

    it("tags the row even when the mock event arrives before the response", () => {
        seed("js-6");
        applyInterceptedEvent(
            JSON.stringify({ type: "mock", id: "js-6", ruleId: "m2" }),
            buffer,
            "dev"
        );
        applyInterceptedEvent(
            JSON.stringify({ type: "response", id: "js-6", status: 500, duration: 3 }),
            buffer,
            "dev"
        );
        const row = formatRequest(buffer.get("js-6")!);
        expect(row).toContain("500");
        expect(row).toContain("[MOCK m2]");
    });
});

describe("hit counting", () => {
    beforeEach(() => __resetMockRules());

    it("a mock event increments the rule's server-side hit count", () => {
        // The count is what tells a shadowed rule (hits=0) from one that fired,
        // and the app is never authoritative for it.
        const buffer = new NetworkBuffer(100);
        const rule = addRule("dev", { url: "/orders", mode: "replace", status: 500 });

        for (const id of ["js-a", "js-b"]) {
            applyInterceptedEvent(
                JSON.stringify({ type: "request", id, method: "GET", url: "https://x/orders" }),
                buffer,
                "dev"
            );
            applyInterceptedEvent(
                JSON.stringify({ type: "mock", id, ruleId: rule.id }),
                buffer,
                "dev"
            );
        }

        expect(listRules("dev")[0].hits).toBe(2);
    });

    it("counts the hit even when the request is not in the buffer", () => {
        // Under the SDK the server buffer is mirrored and carries SDK ids, so
        // the mock event's id will not resolve. The rule still fired.
        const buffer = new NetworkBuffer(100);
        const rule = addRule("dev", { url: "/orders", mode: "replace" });
        applyInterceptedEvent(
            JSON.stringify({ type: "mock", id: "js-unknown", ruleId: rule.id }),
            buffer,
            "dev"
        );
        expect(listRules("dev")[0].hits).toBe(1);
    });

    it("does not count a hit for a device that has no such rule", () => {
        const buffer = new NetworkBuffer(100);
        addRule("iPhone", { url: "/orders", mode: "replace" });
        applyInterceptedEvent(
            JSON.stringify({ type: "mock", id: "js-x", ruleId: "m1" }),
            buffer,
            "android"
        );
        expect(listRules("iPhone")[0].hits).toBe(0);
    });
});

describe("mocked traffic is distinguishable from wire traffic", () => {
    it("marks the request event so the server can exempt it from the CDP gate", () => {
        // A mocked request never reaches the network, so the CDP Network domain
        // cannot report it. Without this marker the dedupe gate drops the only
        // record and the request vanishes from get_network_requests entirely on
        // every CDP-capture target — verified on iOS before the fix.
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 500 }]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/orders");
        xhr.send();
        t.flush();

        const request = t.events().find((e) => e.type === "request")!;
        expect(request.mocked).toBe(true);
        const response = t.events().find((e) => e.type === "response")!;
        expect(response.mocked).toBe(true);
    });

    it("leaves an unmocked request unmarked, so it stays subject to the gate", () => {
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "replace", status: 500 }]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://api.example.com/users");
        xhr.send();
        expect(t.events().find((e) => e.type === "request")!.mocked).toBeUndefined();
    });

    it("marks a mocked network error too", () => {
        const t = runWithMocks([
            { id: "m1", url: "/down", mode: "replace", networkError: "Network request failed" },
        ]);
        const xhr = t.newXhr();
        xhr.open("GET", "https://x.example.com/down");
        xhr.send();
        t.flush();
        expect(t.events().find((e) => e.type === "error")!.mocked).toBe(true);
    });

    it("isMockedTrafficEvent recognises exactly those events", () => {
        expect(isMockedTrafficEvent(JSON.stringify({ type: "request", mocked: true }))).toBe(true);
        expect(isMockedTrafficEvent(JSON.stringify({ type: "request" }))).toBe(false);
        expect(isMockedTrafficEvent(JSON.stringify({ type: "mock", ruleId: "m1" }))).toBe(false);
        expect(isMockedTrafficEvent("not json")).toBe(false);
    });
});
