process.env.EXECBRO_TEST_MODE = "1";

import { describe, it, expect, beforeEach } from "@jest/globals";

const { toolRegistry } = await import("../../index.js");
const { recordAction, resetActionLog } = await import("../../core/actionLog.js");
const { logBuffers, networkBuffers, connectedApps, getLogBuffer, resetEpochs } = await import("../../core/state.js");
const { CHROMIUM_TOOLS } = await import("../../core/chromiumCapabilities.js");

const call = (args: Record<string, unknown>) => toolRegistry.get("get_timeline")!.handler(args);

beforeEach(() => {
    resetActionLog(); resetEpochs();
    logBuffers.clear(); networkBuffers.clear(); connectedApps.clear();
});

describe("get_timeline", () => {
    it("is registered and allowed on chromium", () => {
        expect(toolRegistry.has("get_timeline")).toBe(true);
        expect(CHROMIUM_TOOLS.has("get_timeline")).toBe(true);
    });

    it("starts at the last action by default", async () => {
        const now = Date.now();
        recordAction({ tool: "tap", args: { testID: "add-to-cart" }, startedAt: now - 2000, endedAt: now - 1500, ok: true, meaningful: true });
        getLogBuffer("iPhone").add({ level: "log", message: "before", timestamp: new Date(now - 5000) });
        getLogBuffer("iPhone").add({ level: "log", message: "cart updated", timestamp: new Date(now - 1000) });
        const r = await call({ sources: ["actions", "logs"] });
        const text = r.content[0].text as string;
        expect(text).toMatch(/^Timeline \(iPhone\) since ▶ tap testID=add-to-cart/);
        expect(text).toContain("cart updated");
        expect(text).not.toContain("before");
        expect(r._emptyResult).toBe(false);
    });

    it("says so when it falls back to the last 60s", async () => {
        const r = await call({ sources: ["logs"] });
        expect(r.content[0].text).toContain("No action recorded yet");
        expect(r._emptyResult).toBe(true);
    });

    it("applies the default limit even when zod defaults are skipped", async () => {
        const now = Date.now();
        for (let i = 0; i < 150; i++) getLogBuffer("iPhone").add({ level: "log", message: `m${i}`, timestamp: new Date(now - 10_000 + i) });
        const r = await call({ since: "-30s", sources: ["logs"] });
        expect(r.content[0].text).toContain("Over the limit, omitted: logs 50.");
    });

    it("rejects a bad window with the accepted formats", async () => {
        await expect(call({ since: "yesterday" })).rejects.toThrow(/-30s/);
    });

    it("errors only when every requested source failed", async () => {
        const r = await call({ since: "-30s", sources: ["refresh"] });
        expect(r.isError).toBe(true);
    });

    it("answers a perf-only read with a plain empty window", async () => {
        getLogBuffer("iPhone");
        const r = await call({ since: "-30s", sources: ["perf"] });
        expect(r.isError).toBeUndefined();
        expect(r.content[0].text).toBe("Nothing happened in the 30.0s since -30s on iPhone.");
    });

    it("never names perf in the checked list", async () => {
        getLogBuffer("iPhone");
        const r = await call({ since: "-30s", sources: ["logs", "perf"] });
        expect(r.content[0].text).toContain("(checked: logs)");
    });
});
