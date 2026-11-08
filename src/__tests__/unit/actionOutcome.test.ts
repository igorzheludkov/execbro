import { describe, it, expect } from "@jest/globals";
import { diffSnapshots, buildOutcome, snapshotFromScreenState, snapshotFromLines, TEXT_DIFF_CAP, type OutcomeSnapshot } from "../../core/actionOutcome.js";
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

    it("unknown route but most of the screen replaced: one line, not a diff", () => {
        // No NavigationContainer ref (route reads null), or a same-name push to a new id.
        const before = snapshotFromLines(null, ["Shop", "Shoes", "Hats", "Socks", "Checkout"]);
        const after = snapshotFromLines(null, ["Product", "Shoes", "Size 42", "Add to cart", "Reviews", "Similar"]);
        const o = buildOutcome({ ...none, before, after });
        expect(o.route).toBeUndefined();
        expect(o.text).toEqual(["most of the screen changed (4 of 5 lines): get_screen_state reads it"]);
    });

    it("a small screen changing one line still gets the diff", () => {
        const o = buildOutcome({ ...none, before: snapshotFromLines("A", ["Taps: 0"]), after: snapshotFromLines("A", ["Taps: 1"]) });
        expect(o.text).toEqual(['"Taps: 0" → "Taps: 1"']);
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

describe("snapshotFromLines", () => {
    it("pairs a changed line even when a new line appears above it", () => {
        // Tree order stands in for position: an inserted error shifts later lines by one.
        const before = snapshotFromLines("Login", ["Sign in to the Shop", "Taps: 0", "Sign in"]);
        const after = snapshotFromLines("Login", ["Sign in to the Shop", "Bad password", "Taps: 1", "Sign in"]);
        expect(diffSnapshots(before, after)).toEqual(['+ "Bad password"', '"Taps: 0" → "Taps: 1"']);
    });
});

describe("diff pairing on tree order", () => {
    it("pairs a changed line across two lines inserted above it", () => {
        const before = snapshotFromLines("A", ["Title", "Taps: 0", "Footer"]);
        const after = snapshotFromLines("A", ["Title", "Error one", "Error two", "Taps: 1", "Footer"]);
        expect(diffSnapshots(before, after)).toEqual(['+ "Error one"', '+ "Error two"', '"Taps: 0" → "Taps: 1"']);
    });

    it("does not pair unrelated neighbours: a cart emptying reads as removals and additions", () => {
        // Seen on device after Place order: "1" → "Subtotal: $0.00" was a mispairing.
        const before = snapshotFromLines("Checkout", ["Mascara", "1", "Subtotal: $9.99"]);
        const after = snapshotFromLines("Checkout", ["Your cart is empty", "Subtotal: $0.00"]);
        const lines = diffSnapshots(before, after);
        expect(lines).toContain('"Subtotal: $9.99" → "Subtotal: $0.00"');
        expect(lines).not.toContain('"1" → "Subtotal: $0.00"');
    });

    it("pairs lines that moved far when rows above them were removed (Place order on device)", () => {
        const before = snapshotFromLines("Checkout", ["Eyeshadow Palette with Mirror", "$19.99", "−", "1", "+", "Promo code: (empty)", "Apply", "Free shipping", "Subtotal: $19.99", "Total: $19.99", "Order #1003 placed", "Place order"]);
        const after = snapshotFromLines("Checkout", ["Your cart is empty", "Promo code: (empty)", "Apply", "Free shipping", "Subtotal: $0.00", "Total: $0.00", "Order #1004 placed", "Place order"]);
        const lines = diffSnapshots(before, after);
        expect(lines).toEqual(expect.arrayContaining([
            '"Subtotal: $19.99" → "Subtotal: $0.00"',
            '"Total: $19.99" → "Total: $0.00"',
            '"Order #1003 placed" → "Order #1004 placed"',
            '- "+"',
        ]));
        expect(lines.some((l) => l.startsWith('"+" →'))).toBe(false);
    });

    it("still pairs a line that changed in place with nothing in common", () => {
        // Account screen after Sign out: the same slot now says something else.
        const lines = diffSnapshots(snapshotFromLines("Account", ["Email", "qa.buyer@shop.dev"]), snapshotFromLines("Account", ["Email", "Not signed in"]));
        expect(lines).toEqual(['"qa.buyer@shop.dev" → "Not signed in"']);
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
