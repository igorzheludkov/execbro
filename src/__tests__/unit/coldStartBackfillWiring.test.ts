// Source-level contract, like getLogsNativeSource.test.ts: WHEN the backfill
// runs is about connection setup and read order, which a unit test cannot
// observe without a device.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONN = readFileSync(join(process.cwd(), "src/core/connection.ts"), "utf8");
const TOOLS = readFileSync(join(process.cwd(), "src/tools/logTools.ts"), "utf8");

function toolSource(name: string): string {
    const start = TOOLS.indexOf(`"${name}"`);
    const next = TOOLS.indexOf("registerToolWithTelemetry(", start + 1);
    return TOOLS.slice(start, next === -1 ? undefined : next);
}

describe("cold-start backfill wiring", () => {
    it("connection starts the backfill after the console window opens, not for chromium", () => {
        const opened = CONN.indexOf("markCdpConsoleOpen(bufferKey)");
        const call = CONN.indexOf("startColdStartBackfill(bufferKey)");
        expect(opened).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(opened);
        expect(CONN.slice(opened, call)).toMatch(/isChromiumTarget\(device\)/);
    });

    it.each(["get_logs", "search_logs"])("%s waits for the backfill after refreshing the mirror", (tool) => {
        const src = toolSource(tool);
        const refreshed = src.indexOf("refreshMirror(device)");
        expect(refreshed).toBeGreaterThan(-1);
        expect(src.indexOf("awaitColdStartBackfill(device)")).toBeGreaterThan(refreshed);
    });

    it("descriptions no longer say pre-connect logs are lost or give the old buffer size", () => {
        expect(TOOLS).not.toContain("pre-connect logs are lost");
        expect(TOOLS).not.toContain("won't find pre-connect logs");
        expect(TOOLS).not.toContain("~500 entries");
    });
});
