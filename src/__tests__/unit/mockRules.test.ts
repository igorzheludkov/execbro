import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    addRule,
    removeRule,
    clearRules,
    clearConditionRules,
    listRules,
    recordHit,
    serializeRules,
    validateUrlPattern,
    __resetMockRules,
} from "../../core/mockRules.js";
import { UserInputError } from "../../core/errors.js";

describe("mockRules store", () => {
    beforeEach(() => __resetMockRules());

    it("assigns sequential ids and preserves insertion order", () => {
        const a = addRule("iPhone", { url: "/orders", mode: "replace", status: 500 });
        const b = addRule("iPhone", { url: "/users", mode: "replace", status: 200 });
        expect(a.id).toBe("m1");
        expect(b.id).toBe("m2");
        expect(listRules("iPhone").map((r) => r.id)).toEqual(["m1", "m2"]);
    });

    it("keeps rules isolated per device", () => {
        addRule("iPhone", { url: "/a", mode: "replace" });
        addRule("android", { url: "/b", mode: "replace" });
        expect(listRules("iPhone")).toHaveLength(1);
        expect(listRules("android")).toHaveLength(1);
        expect(listRules("iPhone")[0].url).toBe("/a");
    });

    it("counts hits per rule, starting at zero", () => {
        const r = addRule("iPhone", { url: "/a", mode: "replace" });
        expect(listRules("iPhone")[0].hits).toBe(0);
        recordHit("iPhone", r.id);
        recordHit("iPhone", r.id);
        expect(listRules("iPhone")[0].hits).toBe(2);
    });

    it("removes by id and reports whether anything was removed", () => {
        const r = addRule("iPhone", { url: "/a", mode: "replace" });
        expect(removeRule("iPhone", r.id)).toBe(true);
        expect(removeRule("iPhone", r.id)).toBe(false);
        expect(listRules("iPhone")).toHaveLength(0);
    });

    it("clears one device without touching another, and reports the count", () => {
        addRule("iPhone", { url: "/a", mode: "replace" });
        addRule("iPhone", { url: "/b", mode: "replace" });
        addRule("android", { url: "/c", mode: "replace" });
        expect(clearRules("iPhone")).toBe(2);
        expect(listRules("iPhone")).toHaveLength(0);
        expect(listRules("android")).toHaveLength(1);
    });

    it("ids do not restart after a removal, so a stale id never resolves", () => {
        const a = addRule("iPhone", { url: "/a", mode: "replace" });
        removeRule("iPhone", a.id);
        const b = addRule("iPhone", { url: "/b", mode: "replace" });
        expect(b.id).toBe("m2");
    });
});

describe("mockRules — condition rules are separable from agent mocks", () => {
    beforeEach(() => __resetMockRules());

    it("clearConditionRules removes only rules network_condition created", () => {
        const mine = addRule("iPhone", { url: "/orders", mode: "replace", status: 500 });
        addRule("iPhone", { url: "", mode: "replace", networkError: "Network request failed", source: "condition" });

        expect(clearConditionRules("iPhone")).toBe(1);
        expect(listRules("iPhone").map((r) => r.id)).toEqual([mine.id]);
    });

    it("clearConditionRules is a no-op when no condition is active", () => {
        addRule("iPhone", { url: "/a", mode: "replace" });
        expect(clearConditionRules("iPhone")).toBe(0);
        expect(listRules("iPhone")).toHaveLength(1);
    });

    it("clearRules still removes everything, condition rules included", () => {
        addRule("iPhone", { url: "/a", mode: "replace" });
        addRule("iPhone", { url: "", mode: "replace", source: "condition" });
        expect(clearRules("iPhone")).toBe(2);
        expect(listRules("iPhone")).toHaveLength(0);
    });
});

describe("serializeRules", () => {
    beforeEach(() => __resetMockRules());

    it("strips the server-owned hit counter and the source tag", () => {
        addRule("iPhone", { url: "/a", mode: "replace", status: 500 });
        const json = serializeRules("iPhone");
        expect(JSON.parse(json)).toEqual([{ id: "m1", url: "/a", mode: "replace", status: 500 }]);
        expect(json).not.toContain("hits");
        expect(json).not.toContain("source");
    });

    it("an unknown device serializes to an empty array, not undefined", () => {
        expect(serializeRules("never-seen")).toBe("[]");
    });
});

describe("validateUrlPattern — regex runs on the app's JS thread", () => {
    beforeEach(() => __resetMockRules());

    it("accepts a plain substring unchanged", () => {
        expect(() => validateUrlPattern("/api/orders")).not.toThrow();
    });

    it("accepts a well-behaved slash-wrapped regex", () => {
        expect(() => validateUrlPattern("/\\/orders\\/\\d+$/")).not.toThrow();
    });

    it("rejects a pattern that does not compile", () => {
        expect(() => validateUrlPattern("/[unclosed/")).toThrow(UserInputError);
    });

    it("rejects nested quantifiers, the classic catastrophic-backtracking shape", () => {
        expect(() => validateUrlPattern("/(a+)+$/")).toThrow(/backtrack/i);
        expect(() => validateUrlPattern("/(.*)*x/")).toThrow(/backtrack/i);
        expect(() => validateUrlPattern("/(a|aa)+$/")).toThrow(/backtrack/i);
    });

    it("rejects an over-long pattern before it ever reaches the app", () => {
        expect(() => validateUrlPattern("/" + "a".repeat(300) + "/")).toThrow(/too long/i);
    });

    it("rejects a pattern that is measurably slow on a long input", () => {
        // Survives the structural checks but still backtracks badly.
        expect(() => validateUrlPattern("/^(?:[a-z]+\\s?)+$/")).toThrow(/backtrack|slow/i);
    });

    it("does not apply regex rules to a substring containing regex-ish characters", () => {
        // Not slash-wrapped, so it is a literal substring, not a pattern.
        expect(() => validateUrlPattern("(a+)+")).not.toThrow();
    });

    it("addRule refuses a dangerous pattern rather than storing it", () => {
        expect(() => addRule("iPhone", { url: "/(a+)+$/", mode: "replace" })).toThrow(UserInputError);
        expect(listRules("iPhone")).toHaveLength(0);
    });
});
