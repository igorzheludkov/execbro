// Source-level contract, matching the style of getLogsEmptyContract: the
// escalation path is about WHEN a subprocess runs, which a pure unit test of
// the handler cannot observe without a device.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src/tools/logTools.ts"), "utf8");

function getLogsSource(): string {
    const start = SOURCE.indexOf('"get_logs"');
    const end = SOURCE.indexOf('"search_logs"');
    return SOURCE.slice(start, end);
}

describe("get_logs native source", () => {
    const src = getLogsSource();

    it("declares source, kind, minLevel and since params", () => {
        for (const param of ["source:", "kind:", "minLevel:", "since:"]) {
            expect(src).toContain(param);
        }
    });

    it("defaults source to js so the common path stays subprocess-free", () => {
        expect(src).toMatch(/source[\s\S]{0,200}?\.default\("js"\)/);
    });

    it("only escalates to native when the buffer is empty AND disconnected", () => {
        // Native acquisition costs ~1-1.5s; it must never run on the hot path.
        expect(src).toContain("shouldEscalateToNative");
    });

    it("never calls collectNativeEvents unconditionally", () => {
        const calls = src.match(/collectNativeEvents\(/g) ?? [];
        expect(calls.length).toBeGreaterThan(0);
        // Every call site must be inside a guard.
        expect(src).not.toMatch(/^\s*const .* = await collectNativeEvents\(\{[\s\S]*?\}\);\s*$/m);
    });

    it("computes the native block before every early return that must carry it", () => {
        // source==="all" must be able to prepend nativePrefix to the SDK
        // summary/entries and buffer-summary returns, so the native fetch has
        // to run before those branches, not after.
        const nativeBlockAt = src.indexOf('source === "native" || source === "all"');
        const sdkSummaryAt = src.indexOf("Log Summary (SDK)");
        const bufferSummaryAt = src.indexOf("Log Summary:");
        expect(nativeBlockAt).toBeGreaterThan(-1);
        expect(nativeBlockAt).toBeLessThan(sdkSummaryAt);
        expect(nativeBlockAt).toBeLessThan(bufferSummaryAt);
    });

    it("prepends nativePrefix on every return path, not just the final one", () => {
        // Regression guard for the source:"all" double-pay bug: computing the
        // native block and then dropping it on every early return.
        const prefixSites = src.match(/\$\{nativePrefix\}/g) ?? [];
        // SDK summary, SDK entries, buffer summary, pipeline-recovered,
        // escalation, final.
        expect(prefixSites.length).toBeGreaterThanOrEqual(6);
    });

    it("reuses the native fetch already paid for instead of re-running it in the escalation guard", () => {
        expect(src).toContain("nativeEventsForEscalation");
    });

    it("bounds repeated empty-and-disconnected escalation with a cooldown", () => {
        expect(src).toContain("isEscalationCoolingDown");
    });

    it("flags an unparseable since instead of silently using the default window", () => {
        expect(src).toMatch(/parseSince/);
        expect(SOURCE).toMatch(/not recognized/);
    });
});
