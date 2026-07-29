// Source-level contract, matching the style of getLogsEmptyContract: the
// targeted clear_logs(device=...) branch must clear that device's native
// (logcat/os_log) buffer too, or a repro done right after a targeted clear
// still shows pre-repro native events with no indication why.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src/tools/logTools.ts"), "utf8");

function clearLogsHandlerSource(): string {
    const start = SOURCE.indexOf('"clear_logs"');
    const end = SOURCE.indexOf("Get full payload for one log event");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
}

/** Just the `if (device) { ... }` targeted branch, not the all-devices branch. */
function targetedBranchSource(): string {
    const src = clearLogsHandlerSource();
    const start = src.indexOf("if (device) {");
    const end = src.indexOf("// Clear all");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe("clear_logs(device=...) native buffer", () => {
    it("clears that device's native buffer via getNativeLogBuffer(deviceKey).clear()", () => {
        const targeted = targetedBranchSource();
        expect(targeted).toContain("getNativeLogBuffer(");
        expect(targeted).toContain(".clear()");
    });

    it("folds the native clear count into the reported total", () => {
        const targeted = targetedBranchSource();
        expect(targeted).toMatch(/count\s*\+=\s*getNativeLogBuffer\([\s\S]*?\)\.clear\(\)/);
    });

    it("does not touch the native buffer's watermark reset logic (that lives only in the all-devices branch)", () => {
        // The all-devices branch clears via nativeLogBuffers.values(); the
        // targeted branch must key by this device's own deviceKey instead of
        // iterating every device's native buffer.
        const targeted = targetedBranchSource();
        expect(targeted).not.toContain("nativeLogBuffers.values()");
    });
});
