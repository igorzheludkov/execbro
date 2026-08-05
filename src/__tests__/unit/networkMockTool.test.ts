import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    addRule,
    listRules,
    activeMockBanner,
    formatRuleList,
    __resetMockRules,
} from "../../core/mockRules.js";

describe("network_mock supporting behaviour", () => {
    beforeEach(() => __resetMockRules());

    it("banner is empty with no rules and names the count with rules", () => {
        expect(activeMockBanner("iPhone")).toBe("");
        addRule("iPhone", { url: "/a", mode: "replace" });
        expect(activeMockBanner("iPhone")).toContain("1 mock rule(s) active");
        addRule("iPhone", { url: "/b", mode: "replace" });
        expect(activeMockBanner("iPhone")).toContain("2 mock rule(s) active");
    });

    it("the device-less banner aggregates every device, since reads merge them", () => {
        expect(activeMockBanner()).toBe("");
        addRule("iPhone", { url: "/a", mode: "replace" });
        addRule("android", { url: "/b", mode: "replace" });
        addRule("android", { url: "/c", mode: "replace" });

        const banner = activeMockBanner();
        expect(banner).toContain("3 mock rule(s) active");
        expect(banner).toContain("1 on iPhone");
        expect(banner).toContain("2 on android");
    });

    it("a rule that never matched is visibly distinct from one that did", () => {
        const shadowed = addRule("iPhone", { url: "/api", mode: "replace" });
        const specific = addRule("iPhone", { url: "/api/orders", mode: "replace" });
        expect(listRules("iPhone").map((r) => ({ id: r.id, hits: r.hits }))).toEqual([
            { id: shadowed.id, hits: 0 },
            { id: specific.id, hits: 0 },
        ]);
    });
});

describe("formatRuleList", () => {
    beforeEach(() => __resetMockRules());

    it("says so plainly when there is nothing to list", () => {
        expect(formatRuleList("iPhone")).toBe("No mock rules active.");
    });

    it("renders id, method, url, mode, status, times and hits", () => {
        addRule("iPhone", {
            url: "/orders",
            method: "POST",
            mode: "replace",
            status: 500,
            times: 2,
        });
        const out = formatRuleList("iPhone");
        expect(out).toContain("[m1]");
        expect(out).toContain("POST /orders");
        expect(out).toContain("replace 500");
        expect(out).toContain("times:2");
        expect(out).toContain("hits=0");
    });

    it("shows ANY when the rule is not restricted to a method", () => {
        addRule("iPhone", { url: "/orders", mode: "replace" });
        expect(formatRuleList("iPhone")).toContain("ANY /orders");
    });

    it("explains the shadowing rule, because ordering decides which rule fires", () => {
        addRule("iPhone", { url: "/api", mode: "replace" });
        expect(formatRuleList("iPhone")).toMatch(/order/i);
    });

    it("marks a condition rule as owned by network_condition", () => {
        addRule("iPhone", { url: "", mode: "replace", networkError: "x", source: "condition" });
        expect(formatRuleList("iPhone")).toContain("network_condition");
    });

    it("marks a rule whose times budget is exhausted", () => {
        const r = addRule("iPhone", { url: "/retry", mode: "replace", times: 1 });
        r.hits = 1;
        expect(formatRuleList("iPhone")).toContain("spent");
    });
});
