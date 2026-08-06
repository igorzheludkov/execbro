import { describe, it, expect } from "@jest/globals";
import { buildLogShowCommand, parseLogShowNdjson } from "../../core/logSourceIos.js";

const UDID = "F93612A3-0042-4BDC-855F-8CAB1BDD76C6";

// The builder returns argv for `xcrun` — no shell, so values that contain
// spaces (the predicate, the --start stamp) are single elements and carry no
// quoting of their own.
describe("buildLogShowCommand", () => {
    it("spawns against the given simulator", () => {
        expect(buildLogShowCommand({ udid: UDID }).join(" ")).toContain(`simctl spawn ${UDID}`);
    });

    it("requests ndjson", () => {
        expect(buildLogShowCommand({ udid: UDID }).join(" ")).toContain("--style ndjson");
    });

    it("pushes the process filter into the predicate", () => {
        // 30m app-scoped is 42KB; unfiltered is orders of magnitude more.
        const args = buildLogShowCommand({ udid: UDID, processName: "RnDebuggerTestApp" });
        expect(args[args.indexOf("--predicate") + 1]).toContain(`process == "RnDebuggerTestApp"`);
    });

    it("emits --start in device-local time, not UTC", () => {
        // log show parses a bare --start as LOCAL and rejects an explicit
        // offset, so a UTC stamp shifts the window by the host's offset —
        // over-fetching east of UTC, silently missing crashes west of it.
        const when = new Date(2026, 6, 29, 22, 15, 30);
        const args = buildLogShowCommand({ udid: "U", sinceTs: when });
        expect(args[args.indexOf("--start") + 1]).toBe("2026-07-29 22:15:30");
    });

    it("admits termination verdicts alongside the app's own process", () => {
        // runningboardd — not the app — reports jetsam kills and launch
        // failures. A bare `process ==` predicate excluded every one, which
        // made IOS_VERDICT_SUBSYSTEMS unreachable and the advertised "surfaces
        // crashes and OOM kills" false on iOS. Measured: 9 such lines about
        // the app in a 2-minute window, all dropped.
        const predicate = buildLogShowCommand({ udid: UDID, processName: "AppA" })
            .find((a) => a.includes("process =="))!;
        expect(predicate).toContain(`process == "AppA"`);
        expect(predicate).toContain("com.apple.runningboard");
        expect(predicate).toContain("OR");
    });

    it("keeps a hostile process name as one argument, not shell syntax", () => {
        const hostile = 'App"; touch /tmp/pwned; #';
        const args = buildLogShowCommand({ udid: UDID, processName: hostile });
        // The whole predicate is ONE argv element, so the injected `;` is
        // predicate text and never reaches a shell. Asserted as an exact
        // element rather than a substring: a split would satisfy `toContain`
        // on the array while being precisely the bug this guards.
        const predicate = args[args.indexOf("--predicate") + 1];
        expect(predicate).toContain(`process == "${hostile}"`);
        expect(args.filter((a) => a.includes("touch /tmp/pwned"))).toEqual([predicate]);
    });
});

describe("parseLogShowNdjson", () => {
    const SAMPLE = [
        JSON.stringify({
            timestamp: "2026-07-29 21:34:54.667179+0300",
            messageType: "Error",
            processID: 19743,
            threadID: 1234,
            subsystem: "com.apple.network",
            category: "connection",
            eventMessage: "nw_socket_handle_socket_event [C1.1.1:2] Socket SO_ERROR [61: Connection refused]",
        }),
        JSON.stringify({
            timestamp: "2026-07-29 21:34:47.594000+0300",
            messageType: "Default",
            processID: 19743,
            subsystem: "",
            category: "",
            eventMessage: "_setUpFeatureFlags called with release level 2",
        }),
        JSON.stringify({ count: 888, finished: 1 }),
    ].join("\n");

    it("skips the trailing summary object", () => {
        expect(parseLogShowNdjson(SAMPLE)).toHaveLength(2);
    });

    it("maps messageType onto levels", () => {
        expect(parseLogShowNdjson(SAMPLE)[0].level).toBe("error");
        expect(parseLogShowNdjson(SAMPLE)[1].level).toBe("log");
    });

    it("builds the tag from subsystem and category", () => {
        expect(parseLogShowNdjson(SAMPLE)[0].tag).toBe("com.apple.network:connection");
    });

    it("parses the offset-aware timestamp", () => {
        // 21:34:54.667 +0300 == 18:34:54.667 UTC
        expect(parseLogShowNdjson(SAMPLE)[0].ts.toISOString()).toBe("2026-07-29T18:34:54.667Z");
    });

    it("tolerates malformed lines rather than throwing", () => {
        expect(parseLogShowNdjson("not json\n" + SAMPLE)).toHaveLength(2);
    });
});
