import { describe, it, expect } from "@jest/globals";
import { diffSnapshots, buildOutcome, snapshotFromScreenState, TEXT_DIFF_CAP, type OutcomeSnapshot } from "../../core/actionOutcome.js";
import { requestEvent, logEvent, restartEvent } from "../../core/timeline.js";
import type { ScreenState } from "../../core/screenState.js";
import type { LogEntry, NetworkRequest } from "../../core/types.js";

const snap = (route: string | null, items: Array<[string, number, number]>): OutcomeSnapshot => ({
    route,
    items: items.map(([text, x, y]) => ({ text, x, y })),
});
const none = { events: [], pending: 0, capped: false, unavailable: [] as string[] };

describe("diffSnapshots", () => {
    it("pairs an in-place text change", () => {
        // Tap Targets after tapping Submit, measured on device.
        const before = snap("TapTargets", [["Taps: 0", 446, 715], ["Last: none", 446, 791]]);
        const after = snap("TapTargets", [["Taps: 1", 446, 715], ["Last: submit-btn", 446, 791]]);
        expect(diffSnapshots(before, after)).toEqual(['"Taps: 0" → "Taps: 1"', '"Last: none" → "Last: submit-btn"']);
    });

    it("reports appeared text", () => {
        const before = snap("Login", [["Sign in", 446, 801]]);
        const after = snap("Login", [["Cannot read property 'setGenericPasswordForOptions' of null", 446, 684], ["Sign in", 446, 801]]);
        expect(diffSnapshots(before, after)).toEqual([`+ "Cannot read property 'setGenericPasswordForOptions' of null"`]);
    });

    it("reports disappeared text", () => {
        expect(diffSnapshots(snap("A", [["Loading…", 10, 10], ["Title", 10, 50]]), snap("A", [["Title", 10, 50]]))).toEqual(['- "Loading…"']);
    });

    it("does not pair texts far apart vertically", () => {
        const lines = diffSnapshots(snap("A", [["old", 10, 100]]), snap("A", [["new", 10, 400]]));
        expect(lines).toEqual(['- "old"', '+ "new"']);
    });

    it("caps at TEXT_DIFF_CAP with a pointer", () => {
        const after = snap("A", Array.from({ length: 14 }, (_, i) => [`row ${i}`, 10, i * 100] as [string, number, number]));
        const lines = diffSnapshots(snap("A", []), after);
        expect(lines).toHaveLength(TEXT_DIFF_CAP + 1);
        expect(lines[TEXT_DIFF_CAP]).toBe("+4 more, get_screen_state for all");
    });

    it("diff of masked values never contains the raw text", () => {
        const lines = diffSnapshots(
            snap("Login", [["Password: [masked, 3 chars]", 446, 572]]),
            snap("Login", [["Password: [masked, 4 chars]", 446, 572]])
        );
        expect(lines).toEqual(['"Password: [masked, 3 chars]" → "Password: [masked, 4 chars]"']);
    });

    it("is empty when nothing changed", () => {
        const s = snap("A", [["x", 1, 1], ["x", 1, 50]]);
        expect(diffSnapshots(s, s)).toEqual([]);
    });
});

describe("buildOutcome", () => {
    it("route change replaces the text diff with one line", () => {
        const o = buildOutcome({ ...none, before: snap("Login", [["Sign in", 1, 1]]), after: snap("ProductList", [["Shoes", 1, 1], ["Hats", 1, 2]]) });
        expect(o.route).toBe("Login → ProductList");
        expect(o.text).toEqual(["new screen (route changed): get_screen_state reads it"]);
    });

    it("unchanged route and no text change omit text", () => {
        const s = snap("TapTargets", [["Taps: 0", 1, 1]]);
        const o = buildOutcome({ ...none, before: s, after: s });
        expect(o.route).toBe("unchanged (TapTargets)");
        expect(o.text).toBeUndefined();
    });

    it("splits events into network, console and restart, dropping info logs", () => {
        const req = { requestId: "sdk-1", timestamp: new Date(1000), method: "POST", url: "http://localhost:8092/auth/login", headers: {}, status: 200, timing: { duration: 79 }, completed: true, epoch: 1 } as NetworkRequest;
        const log = (level: LogEntry["level"], message: string, seq: number) => ({ timestamp: new Date(1100), level, message, seq, epoch: 1 }) as LogEntry;
        const events = [
            requestEvent(req, "d", false),
            logEvent(log("error", "boom", 1), "d"),
            logEvent(log("warn", "careful", 2), "d"),
            logEvent(log("log", "chatter", 3), "d"),
            restartEvent(2, 1200, "d"),
        ];
        const o = buildOutcome({ ...none, before: null, after: null, events });
        expect(o.network).toEqual([events[0].text]);
        expect(o.console).toEqual([events[1].text, events[2].text]);
        expect(o.restart).toBe(events[4].text);
    });

    it("reports pending only when capped", () => {
        const o = buildOutcome({ before: null, after: null, events: [], pending: 2, capped: true, unavailable: ["route", "text: no React Native connection"] });
        expect(o.pending).toBe("2 request(s) still in flight after 3s: get_timeline() shows the rest");
        expect(o.unavailable).toEqual(["route", "text: no React Native connection"]);
        expect(buildOutcome({ ...none, before: null, after: null, pending: 0, capped: true }).pending).toBeUndefined();
    });
});

describe("snapshotFromScreenState", () => {
    it("takes texts, labels, masked input values and switch values, with the route", () => {
        const at = (x: number, y: number) => ({ center: { x, y }, bounds: { x, y, width: 1, height: 1 } });
        const ss: ScreenState = {
            route: { name: "Login", params: null, stack: ["Shop", "Login"] },
            overlays: [{ type: "Modal", title: "Oops", pressables: [{ label: "OK", testID: null, ...at(5, 900) }], texts: [{ text: "Something failed", ...at(5, 850) }] }],
            pressables: [
                { label: "Password", testID: "login-password", isInput: true, inputValue: "[masked, 8 chars]", ...at(446, 572) },
                { label: "Notifications", testID: null, switchValue: true, ...at(446, 700) },
                { label: "Sign in", testID: "login-submit", ...at(446, 801) },
            ],
            texts: [{ text: "Sign in to the Shop", ...at(446, 323) }],
            images: [],
        };
        const s = snapshotFromScreenState(ss);
        expect(s.route).toBe("Login");
        expect(s.items.map((i) => i.text)).toEqual(expect.arrayContaining([
            "Sign in to the Shop",
            "Password: [masked, 8 chars]",
            "[switch:ON] Notifications",
            "Sign in",
            "Something failed",
            "OK",
        ]));
    });
});
