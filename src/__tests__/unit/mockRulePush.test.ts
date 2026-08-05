import { describe, it, expect, beforeEach } from "@jest/globals";
import { buildMockPushScript } from "../../core/networkInterceptor.js";
import { addRule, serializeRules, __resetMockRules } from "../../core/mockRules.js";
import { runWithMocks } from "../helpers/mock-harness.js";

describe("mock rule push payload", () => {
    beforeEach(() => __resetMockRules());

    it("serializes rules without the server-owned hit counter", () => {
        addRule("iPhone", { url: "/a", mode: "replace", status: 500 });
        const json = serializeRules("iPhone");
        expect(JSON.parse(json)).toEqual([{ id: "m1", url: "/a", mode: "replace", status: 500 }]);
        expect(json).not.toContain("hits");
    });

    it("builds a script that assigns the app's rule list", () => {
        const script = buildMockPushScript('[{"id":"m1"}]');
        expect(script).toContain("__RN_NET_MOCKS__");
        expect(script).toContain('[{"id":"m1"}]');
    });

    it("an empty rule set pushes an empty array, not a no-op", () => {
        // Clearing must actively overwrite the app's list; skipping the push
        // would leave stale rules live after network_mock({action:"clear"}).
        expect(serializeRules("iPhone")).toBe("[]");

        const t = runWithMocks([{ id: "m1", url: "/a", mode: "replace", status: 500 }]);
        t.push(JSON.parse(serializeRules("iPhone")));

        const xhr = t.newXhr();
        xhr.open("GET", "https://x.example.com/a");
        xhr.send();
        expect(xhr.sendCalled).toBe(1); // reached the wire — the rule is gone
        expect(t.sandbox.__RN_NET_MOCKS__).toEqual([]);
    });
});

describe("pushing rules to a live context", () => {
    it("a spent times budget is not rearmed by an unrelated rule being added", () => {
        // Rules are re-pushed on every mutation. Without carrying __used across
        // the push, adding a second rule would silently rearm a spent
        // `times: 1` rule — breaking the retry test the option exists for.
        const t = runWithMocks([{ id: "m1", url: "/retry", mode: "replace", status: 503, times: 1 }]);

        const first = t.newXhr();
        first.open("GET", "https://x.example.com/retry");
        first.send();
        t.flush();
        expect(first.status).toBe(503);

        t.push([
            { id: "m1", url: "/retry", mode: "replace", status: 503, times: 1 },
            { id: "m2", url: "/other", mode: "replace", status: 500 },
        ]);

        const second = t.newXhr();
        second.open("GET", "https://x.example.com/retry");
        second.send();
        expect(second.sendCalled).toBe(1); // still spent
    });

    it("a rule pushed after startup takes effect without re-injecting", () => {
        const t = runWithMocks([]);
        t.push([{ id: "m1", url: "/late", mode: "replace", status: 402 }]);

        const xhr = t.newXhr();
        xhr.open("GET", "https://x.example.com/late");
        xhr.send();
        t.flush();
        expect(xhr.status).toBe(402);
    });

    it("re-injecting the interceptor does not drop the rules already pushed", () => {
        // Injection is idempotent, but the mock list must survive it too — the
        // interceptor is re-injected on every execution context event.
        const t = runWithMocks([{ id: "m1", url: "/keep", mode: "replace", status: 500 }]);
        t.reinject();

        const xhr = t.newXhr();
        xhr.open("GET", "https://x.example.com/keep");
        xhr.send();
        t.flush();
        expect(xhr.status).toBe(500);
    });
});
