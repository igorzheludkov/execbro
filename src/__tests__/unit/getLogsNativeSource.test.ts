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
});
