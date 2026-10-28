import { describe, it, expect } from "@jest/globals";
import {
    resolveWindow, actionEvent, logEvent, requestEvent, routeEvent, restartEvent, refreshEvent,
    sortEvents, trimEvents, formatRelative, formatTimeline, FALLBACK_WINDOW_MS, type TimelineEvent,
} from "../../core/timeline.js";
import type { ActionEntry } from "../../core/actionLog.js";
import type { LogEntry, NetworkRequest } from "../../core/types.js";

const NOW = 1_800_000_000_000;
const tapAction: ActionEntry = { tool: "tap", device: null, startedAt: NOW - 3400, endedAt: NOW - 2400, ok: true, summary: "testID=add-to-cart", outcome: "screen changed" };

function log(level: LogEntry["level"], message: string, at: number, seq = 1): LogEntry {
    return { level, message, timestamp: new Date(at), seq, epoch: 1 };
}

function req(over: Partial<NetworkRequest>): NetworkRequest {
    return { requestId: "42", timestamp: new Date(NOW - 3000), method: "GET", url: "https://api.shop.com/cart", headers: {}, completed: true, epoch: 1, ...over };
}

describe("resolveWindow", () => {
    it("defaults to the last action", () => {
        const w = resolveWindow({ now: NOW, lastAction: tapAction });
        expect(w).toEqual({ start: NOW - 3400, end: NOW, label: "▶ tap testID=add-to-cart", fallback: false });
    });

    it("falls back to the last 60s when nothing was done yet", () => {
        const w = resolveWindow({ now: NOW, lastAction: null });
        expect(w.start).toBe(NOW - FALLBACK_WINDOW_MS);
        expect(w.fallback).toBe(true);
    });

    it("accepts relative strings", () => {
        expect(resolveWindow({ since: "-30s", now: NOW, lastAction: null }).start).toBe(NOW - 30_000);
        expect(resolveWindow({ since: "-5m", now: NOW, lastAction: null }).start).toBe(NOW - 300_000);
        expect(resolveWindow({ since: "-1h", now: NOW, lastAction: null }).start).toBe(NOW - 3_600_000);
        expect(resolveWindow({ since: "-250ms", now: NOW, lastAction: null }).start).toBe(NOW - 250);
    });

    it("accepts epoch ms as a number or a numeric string", () => {
        expect(resolveWindow({ since: NOW - 10, now: NOW, lastAction: null }).start).toBe(NOW - 10);
        expect(resolveWindow({ since: String(NOW - 10), now: NOW, lastAction: null }).start).toBe(NOW - 10);
    });

    it("rejects nonsense with a message naming the formats", () => {
        expect(() => resolveWindow({ since: "yesterday", now: NOW, lastAction: null })).toThrow(/-30s/);
        expect(() => resolveWindow({ until: "last_action", now: NOW, lastAction: tapAction })).toThrow(/until/);
        expect(() => resolveWindow({ since: "-1s", until: "-5s", now: NOW, lastAction: null })).toThrow(/after/);
    });
});

describe("event builders", () => {
    it("renders an action with its outcome, and a failure", () => {
        expect(actionEvent(tapAction, "d").text).toBe("▶ tap testID=add-to-cart → ok, screen changed");
        expect(actionEvent({ ...tapAction, ok: false, outcome: "no element" }, "d").text).toBe("▶ tap testID=add-to-cart → failed: no element");
    });

    it("marks log levels and keeps the j id", () => {
        const e = logEvent(log("error", "Failed to load", NOW, 813), "d");
        expect(e.text).toBe('✖ error "Failed to load"  [j813]');
        expect(e.tier).toBe(4);
        expect(logEvent(log("warn", "slow", NOW), "d").tier).toBe(6);
        expect(logEvent(log("log", "x".repeat(300), NOW), "d").text.length).toBeLessThan(150);
    });

    it("renders request outcomes: status, failure, pending, mock", () => {
        expect(requestEvent(req({ status: 201, method: "POST", timing: { duration: 180 } }), "d", false).text)
            .toBe("⇄ POST /cart 201 · 180ms  [n42]");
        const failed = requestEvent(req({ status: 500 }), "d", false);
        expect(failed.tier).toBe(5);
        expect(requestEvent(req({ completed: false, status: undefined }), "d", false).text).toContain(" pending ");
        expect(requestEvent(req({ error: "Network request failed", completed: true }), "d", false).text).toContain("failed: Network request failed");
        expect(requestEvent(req({ status: 200, mocked: true }), "d", false).text).toContain("[MOCK] GET");
        expect(requestEvent(req({ status: 200 }), "d", true).text).toContain("api.shop.com/cart");
    });

    it("renders routes, restarts and refreshes", () => {
        expect(routeEvent({ route: "Cart", from: "ProductDetails", at: NOW }, "d").text).toBe("➜ route Cart (from ProductDetails)");
        expect(routeEvent({ route: "Cart", from: null, at: NOW }, "d").text).toBe("➜ route Cart");
        expect(restartEvent(3, NOW, "d").text).toBe("⟳ app restarted (epoch 3)");
        expect(refreshEvent({ at: NOW, modulePath: "/app/src/Cart.tsx" }, NOW, "d").text).toBe("↻ edit applied: Cart.tsx");
        expect(refreshEvent({ at: NOW }, NOW, "d").text).toBe("↻ edit applied (Fast Refresh)");
    });
});

describe("sortEvents and trimEvents", () => {
    it("orders same-millisecond events restart, action, route, request, log, refresh", () => {
        const at = NOW;
        const events: TimelineEvent[] = [
            refreshEvent({ at }, at, "d"),
            logEvent(log("log", "l", at), "d"),
            requestEvent(req({ timestamp: new Date(at), status: 200 }), "d", false),
            routeEvent({ route: "R", from: null, at }, "d"),
            actionEvent({ ...tapAction, startedAt: at }, "d"),
            restartEvent(2, at, "d"),
        ];
        expect(sortEvents(events).map((e) => e.kind)).toEqual(["restart", "action", "route", "request", "log", "refresh"]);
    });

    // Reserved for tracker item 2: a perf line sorts right after its route and survives the limit with routes.
    const perf = (at: number): TimelineEvent => ({ at, kind: "perf", source: "perf", device: "d", tier: 2, text: "◷ settled" });

    it("sorts a same-millisecond perf event after the route", () => {
        const events = [requestEvent(req({ timestamp: new Date(NOW), status: 200 }), "d", false), perf(NOW), routeEvent({ route: "R", from: null, at: NOW }, "d")];
        expect(sortEvents(events).map((e) => e.kind)).toEqual(["route", "perf", "request"]);
    });

    it("keeps perf at the route tier, ahead of refresh and errors", () => {
        const events = [logEvent(log("error", "e", NOW - 3000, 1), "d"), refreshEvent({ at: NOW - 2000 }, NOW - 2000, "d"), perf(NOW - 1000)];
        expect(trimEvents(events, 1).kept.map((e) => e.kind)).toEqual(["perf"]);
    });

    it("keeps high tiers first, earliest within a tier, and counts what it dropped", () => {
        const events: TimelineEvent[] = [
            actionEvent(tapAction, "d"),
            ...Array.from({ length: 5 }, (_, i) => logEvent(log("log", `l${i}`, NOW - 3000 + i, i), "d")),
            logEvent(log("error", "boom", NOW - 1000, 99), "d"),
            requestEvent(req({ status: 200 }), "d", false),
        ];
        const { kept, dropped } = trimEvents(events, 4);
        expect(kept.map((e) => e.text)).toEqual([
            "▶ tap testID=add-to-cart → ok, screen changed",
            "⇄ GET /cart 200  [n42]",
            '· log "l0"  [j0]',
            '✖ error "boom"  [j99]',
        ]);
        expect(dropped).toEqual({ logs: 4 });
    });

    it("returns everything sorted when under the limit", () => {
        const { kept, dropped } = trimEvents([logEvent(log("log", "b", NOW), "d"), actionEvent(tapAction, "d")], 10);
        expect(kept[0].kind).toBe("action");
        expect(dropped).toEqual({});
    });
});

describe("formatRelative", () => {
    it("uses ms, then seconds, then minutes", () => {
        expect(formatRelative(0)).toBe("+0ms");
        expect(formatRelative(905)).toBe("+905ms");
        expect(formatRelative(2100)).toBe("+2.1s");
        expect(formatRelative(125_000)).toBe("+2m05s");
    });
});

describe("formatTimeline", () => {
    const window = { start: NOW - 3400, end: NOW, label: "▶ tap testID=add-to-cart", fallback: false };

    it("renders header, lines, id hint and notes", () => {
        const events = sortEvents([
            actionEvent(tapAction, "iPhone"),
            requestEvent(req({ timestamp: new Date(NOW - 3280), status: 201, method: "POST", timing: { duration: 180 } }), "iPhone", false),
            logEvent(log("error", "Failed", NOW - 2495, 813), "iPhone"),
        ]);
        const text = formatTimeline({ window, deviceLabel: "iPhone", events, tagDevices: false, dropped: {}, notes: ["a note"], checked: ["actions", "network", "logs"] });
        const lines = text.split("\n");
        expect(lines[0]).toBe("Timeline (iPhone) since ▶ tap testID=add-to-cart · 3.4s · 3 events");
        expect(lines[1]).toBe("+0ms    ▶ tap testID=add-to-cart → ok, screen changed");
        expect(lines[2]).toBe("+120ms  ⇄ POST /cart 201 · 180ms  [n42]");
        expect(lines[3]).toBe('+905ms  ✖ error "Failed"  [j813]');
        expect(text).toContain('get_log_details({ id: "j813" })');
        expect(text).toContain('get_request_details({ requestId: "42" })');
        expect(text).toContain("a note");
    });

    it("tags devices when several are merged", () => {
        const text = formatTimeline({ window, deviceLabel: "all devices", events: [actionEvent(tapAction, "Pixel")], tagDevices: true, dropped: {}, notes: [], checked: ["actions"] });
        expect(text).toContain("[Pixel] ▶ tap");
    });

    it("names what was dropped over the limit", () => {
        const text = formatTimeline({ window, deviceLabel: "iPhone", events: [actionEvent(tapAction, "d")], tagDevices: false, dropped: { logs: 40, network: 12 }, notes: [], checked: ["actions"] });
        expect(text).toContain("Over the limit, omitted: logs 40, network 12.");
    });

    it("says plainly when nothing happened", () => {
        const text = formatTimeline({ window, deviceLabel: "iPhone", events: [], tagDevices: false, dropped: {}, notes: [], checked: ["actions", "logs"] });
        expect(text).toBe("Nothing happened in the 3.4s since ▶ tap testID=add-to-cart on iPhone (checked: actions, logs).\nLog capture is not re-verified by this read; if you expected output, get_logs checks the pipeline.");
    });

    it("drops the checked list when nothing was checked", () => {
        const text = formatTimeline({ window, deviceLabel: "iPhone", events: [], tagDevices: false, dropped: {}, notes: [], checked: [] });
        expect(text).toBe("Nothing happened in the 3.4s since ▶ tap testID=add-to-cart on iPhone.");
    });
});
