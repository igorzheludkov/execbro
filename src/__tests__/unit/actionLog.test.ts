import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    recordAction, getActions, lastAction, resetActionLog, summarizeArgs,
    deviceMatches, actionLabel, ACTION_TOOLS,
} from "../../core/actionLog.js";

const base = { startedAt: 1000, endedAt: 1500, ok: true };

describe("recordAction", () => {
    beforeEach(() => resetActionLog());

    it("records action tools and ignores read tools", () => {
        recordAction({ ...base, tool: "tap", args: { testID: "add-to-cart" } });
        recordAction({ ...base, tool: "get_logs", args: {} });
        expect(getActions().map((a) => a.tool)).toEqual(["tap"]);
    });

    it("records a failure with its reason, cut to 80 chars", () => {
        recordAction({ ...base, tool: "tap", args: { text: "Pay" }, ok: false, error: "x".repeat(200) });
        const a = getActions()[0];
        expect(a.ok).toBe(false);
        expect(a.outcome).toBe("x".repeat(80));
    });

    it("turns the pixel-diff verdict into an outcome", () => {
        recordAction({ ...base, tool: "tap", args: { testID: "a" }, meaningful: true });
        recordAction({ ...base, tool: "swipe", args: { direction: "up" }, meaningful: false });
        expect(getActions().map((a) => a.outcome)).toEqual(["screen changed", "no visible change"]);
    });

    it("keeps the device argument, or null", () => {
        recordAction({ ...base, tool: "tap", args: { testID: "a", device: "iPhone" } });
        recordAction({ ...base, tool: "tap", args: { testID: "b" } });
        expect(getActions().map((a) => a.device)).toEqual(["iPhone", null]);
    });

    it("caps the ring at 200", () => {
        for (let i = 0; i < 210; i++) recordAction({ ...base, tool: "tap", args: { x: i, y: 1 } });
        const all = getActions();
        expect(all).toHaveLength(200);
        expect(all[0].summary).toBe("(10,1)");
    });

    it("never throws, even on hostile args", () => {
        const hostile = { get testID() { throw new Error("boom"); } };
        expect(() => recordAction({ ...base, tool: "tap", args: hostile })).not.toThrow();
    });
});

describe("summarizeArgs", () => {
    it("redacts a credential before cutting, so a split token cannot slip past", () => {
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
        const s = summarizeArgs("execute_in_app", { expression: `fetch(u, {headers: {a: "${jwt}"}})` });
        expect(s).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    });

    it("never includes the text typed by input_text", () => {
        const s = summarizeArgs("input_text", { testID: "password", text: "hunter2-secret" });
        expect(s).toBe("testID=password 14 chars");
        expect(s).not.toContain("hunter2");
    });

    it("names an untargeted input_text as the focused field", () => {
        expect(summarizeArgs("input_text", { text: "abc", native: true })).toBe("focused field 3 chars");
    });

    it("renders tap targets in priority order", () => {
        expect(summarizeArgs("tap", { testID: "go", text: "Go" })).toBe("testID=go");
        expect(summarizeArgs("tap", { text: "Checkout" })).toBe('text="Checkout"');
        expect(summarizeArgs("tap", { component: "CartIcon" })).toBe("component=CartIcon");
        expect(summarizeArgs("tap", { x: 300, y: 600 })).toBe("(300,600)");
        expect(summarizeArgs("tap", { testID: "row", duration: 800 })).toBe("testID=row hold 800ms");
    });

    it("cuts execute_in_app expressions to one 60-char line", () => {
        const expr = "const a = 1;\n" + "b".repeat(100);
        const s = summarizeArgs("execute_in_app", { expression: expr });
        expect(s).not.toContain("\n");
        expect(s.length).toBeLessThanOrEqual(61);
        expect(s.endsWith("…")).toBe(true);
    });

    it("covers the other action tools", () => {
        expect(summarizeArgs("swipe", { direction: "up" })).toBe("up");
        expect(summarizeArgs("swipe", { startX: 1, startY: 2, endX: 3, endY: 4 })).toBe("(1,2)→(3,4)");
        expect(summarizeArgs("press_key", { key: "Enter", repeat: 3 })).toBe("Enter ×3");
        expect(summarizeArgs("navigate", { to: "/checkout" })).toBe("/checkout");
        expect(summarizeArgs("navigate", { screen: "TarotNav" })).toBe("TarotNav");
        expect(summarizeArgs("network_mock", { action: "add", url: "/api/orders" })).toBe("add /api/orders");
        expect(summarizeArgs("network_condition", { mode: "offline" })).toBe("offline");
        expect(summarizeArgs("redux_dispatch", { action: [{ type: "cart/add" }, { type: "cart/clear" }] })).toBe("cart/add, cart/clear");
        expect(summarizeArgs("app_request", { method: "POST", url: "https://api.x.com/orders?a=1" })).toBe("POST /orders?a=1");
        expect(summarizeArgs("network_replay", { requestId: "42" })).toBe("request 42");
        expect(summarizeArgs("reload_app", {})).toBe("");
    });
});

describe("lastAction and deviceMatches", () => {
    beforeEach(() => resetActionLog());

    it("returns the newest action, optionally for one device", () => {
        recordAction({ ...base, tool: "tap", args: { testID: "a", device: "iPhone" } });
        recordAction({ ...base, startedAt: 2000, tool: "tap", args: { testID: "b", device: "Pixel" } });
        expect(lastAction()?.summary).toBe("testID=b");
        expect(lastAction("iphone")?.summary).toBe("testID=a");
        expect(lastAction("nothing")).toBeNull();
    });

    it("does not let an execute_in_app read move the default window off the tap", () => {
        recordAction({ ...base, tool: "tap", args: { testID: "add-to-cart" } });
        recordAction({ ...base, startedAt: 2000, tool: "execute_in_app", args: { expression: "store.getState().cart" } });
        expect(lastAction()?.summary).toBe("testID=add-to-cart");
        expect(getActions().map((a) => a.tool)).toEqual(["tap", "execute_in_app"]);
    });

    it("anchors on execute_in_app when nothing else was done", () => {
        recordAction({ ...base, tool: "execute_in_app", args: { expression: "1" } });
        expect(lastAction()?.tool).toBe("execute_in_app");
    });

    it("treats an action without a device as belonging to any device", () => {
        expect(deviceMatches(null, "iPhone 17 Pro")).toBe(true);
        expect(deviceMatches("iphone", "iPhone 17 Pro")).toBe(true);
        expect(deviceMatches("iPhone 17 Pro", "iphone")).toBe(true);
        expect(deviceMatches("Pixel", "iPhone 17 Pro")).toBe(false);
    });

    it("labels an action by tool and summary", () => {
        recordAction({ ...base, tool: "tap", args: { testID: "go" } });
        recordAction({ ...base, tool: "reload_app", args: {} });
        expect(getActions().map(actionLabel)).toEqual(["tap testID=go", "reload_app"]);
    });

    it("lists only tools that change state", () => {
        expect(ACTION_TOOLS.has("execute_in_app")).toBe(true);
        expect(ACTION_TOOLS.has("get_timeline")).toBe(false);
    });
});
