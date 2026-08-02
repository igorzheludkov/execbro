import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    formatDwell,
    formatRouteTrail,
    recordSampledRoute,
    mergeListenerEntries,
    sampledVisits,
    resetSampledRoutes,
    type RouteHistoryResult
} from "../../core/routeHistory.js";

const NOW = 1_000_000;

describe("formatDwell", () => {
    it("renders seconds under a minute", () => {
        expect(formatDwell(42_000)).toBe("42s");
    });
    it("renders minutes and seconds under an hour", () => {
        expect(formatDwell(572_000)).toBe("9m32s");
    });
    it("renders hours and minutes beyond an hour", () => {
        expect(formatDwell(3_840_000)).toBe("1h04m");
    });
    it("floors sub-second dwell to 0s", () => {
        expect(formatDwell(400)).toBe("0s");
    });
});

describe("formatRouteTrail", () => {
    it("renders most recent first with origin and dwell", () => {
        const r: RouteHistoryResult = {
            mode: "listener",
            visits: [
                { route: "Redux", from: "TapTargets", enteredAt: NOW - 600_000, leftAt: NOW - 582_000, epoch: 1 },
                { route: "TapTargets", from: "Redux", enteredAt: NOW - 582_000, leftAt: NOW - 42_000, epoch: 1 },
                { route: "Apollo", from: "TapTargets", enteredAt: NOW - 42_000, leftAt: null, epoch: 1 }
            ]
        };
        const lines = formatRouteTrail(r, NOW).split("\n").filter((l: string) => l.includes("←"));
        expect(lines[0]).toContain("Apollo");
        expect(lines[0]).toContain("42s");
        expect(lines[0]).toContain("from TapTargets");
        expect(lines[1]).toContain("TapTargets");
        expect(lines[1]).toContain("9m00s");
        expect(lines[2]).toContain("Redux");
        expect(lines[2]).toContain("18s");
    });

    it("inserts a restart divider at an epoch boundary", () => {
        const r: RouteHistoryResult = {
            mode: "listener",
            visits: [
                { route: "Redux", from: null, enteredAt: NOW - 90_000, leftAt: NOW - 60_000, epoch: 1 },
                { route: "Apollo", from: null, enteredAt: NOW - 30_000, leftAt: null, epoch: 2 }
            ]
        };
        expect(formatRouteTrail(r, NOW)).toContain("app restarted (epoch 2)");
    });

    it("declares sampled mode so a thin trail is not mistaken for a complete one", () => {
        const r: RouteHistoryResult = {
            mode: "sampled",
            visits: [{ route: "Apollo", from: null, enteredAt: NOW - 5_000, leftAt: null, epoch: 1 }]
        };
        expect(formatRouteTrail(r, NOW)).toContain("sampled");
    });

    it("does not claim sampling when a listener is attached", () => {
        const r: RouteHistoryResult = {
            mode: "listener",
            visits: [{ route: "Apollo", from: null, enteredAt: NOW - 5_000, leftAt: null, epoch: 1 }]
        };
        expect(formatRouteTrail(r, NOW)).not.toContain("sampled");
    });

    it("says so when nothing has been recorded", () => {
        expect(formatRouteTrail({ mode: "listener", visits: [] }, NOW)).toContain("no route changes recorded");
    });
});

describe("sampled route recording", () => {
    beforeEach(() => resetSampledRoutes());

    it("opens a visit on first observation", () => {
        recordSampledRoute("dev1", "Apollo", 1, 1000);
        expect(sampledVisits("dev1")).toEqual([
            { route: "Apollo", from: null, enteredAt: 1000, leftAt: null, epoch: 1 }
        ]);
    });

    it("closes the previous visit and attributes origin on change", () => {
        recordSampledRoute("dev1", "Apollo", 1, 1000);
        recordSampledRoute("dev1", "Redux", 1, 5000);
        const v = sampledVisits("dev1");
        expect(v[0].leftAt).toBe(5000);
        expect(v[1]).toEqual({ route: "Redux", from: "Apollo", enteredAt: 5000, leftAt: null, epoch: 1 });
    });

    it("ignores repeat observations of the same route", () => {
        recordSampledRoute("dev1", "Apollo", 1, 1000);
        recordSampledRoute("dev1", "Apollo", 1, 4000);
        expect(sampledVisits("dev1")).toHaveLength(1);
    });

    // A restart is a new visit even when the route name did not change, so a
    // reload cannot masquerade as one long uninterrupted dwell.
    it("starts a fresh visit with no origin after a restart", () => {
        recordSampledRoute("dev1", "Apollo", 1, 1000);
        recordSampledRoute("dev1", "Apollo", 2, 9000);
        const v = sampledVisits("dev1");
        expect(v).toHaveLength(2);
        expect(v[0].leftAt).toBe(9000);
        expect(v[1]).toEqual({ route: "Apollo", from: null, enteredAt: 9000, leftAt: null, epoch: 2 });
    });

    it("keeps devices independent", () => {
        recordSampledRoute("dev1", "Apollo", 1, 1000);
        recordSampledRoute("dev2", "Redux", 1, 1000);
        expect(sampledVisits("dev1")).toHaveLength(1);
        expect(sampledVisits("dev2")[0].route).toBe("Redux");
    });

    it("ignores an empty route name", () => {
        recordSampledRoute("dev1", "", 1, 1000);
        expect(sampledVisits("dev1")).toHaveLength(0);
    });
});

describe("mergeListenerEntries", () => {
    beforeEach(() => resetSampledRoutes());

    it("keeps earlier runs so the trail survives a reload", () => {
        mergeListenerEntries("dev1", [
            { route: "Apollo", from: null, enteredAt: 1000, leftAt: 2000 },
            { route: "Redux", from: "Apollo", enteredAt: 2000, leftAt: null }
        ], 1);
        // The runtime restarted: a fresh in-app buffer holding only the new run.
        mergeListenerEntries("dev1", [
            { route: "Tanstack", from: null, enteredAt: 9000, leftAt: null }
        ], 2);

        const v = sampledVisits("dev1");
        expect(v.map((x) => x.route)).toEqual(["Apollo", "Redux", "Tanstack"]);
        expect(v.map((x) => x.epoch)).toEqual([1, 1, 2]);
    });

    it("closes the last visit of the previous run at the restart", () => {
        mergeListenerEntries("dev1", [{ route: "Redux", from: null, enteredAt: 2000, leftAt: null }], 1);
        mergeListenerEntries("dev1", [{ route: "Tanstack", from: null, enteredAt: 9000, leftAt: null }], 2);
        expect(sampledVisits("dev1")[0].leftAt).toBe(9000);
    });

    it("is idempotent — re-reading the same buffer does not duplicate", () => {
        const entries = [{ route: "Apollo", from: null, enteredAt: 1000, leftAt: null }];
        mergeListenerEntries("dev1", entries, 1);
        mergeListenerEntries("dev1", entries, 1);
        expect(sampledVisits("dev1")).toHaveLength(1);
    });

    it("produces a trail that renders a restart divider", () => {
        mergeListenerEntries("dev1", [{ route: "Redux", from: null, enteredAt: 2000, leftAt: null }], 1);
        mergeListenerEntries("dev1", [{ route: "Tanstack", from: null, enteredAt: 9000, leftAt: null }], 2);
        const out = formatRouteTrail({ mode: "listener", visits: sampledVisits("dev1") }, 10_000);
        expect(out).toContain("app restarted (epoch 2)");
    });
});
