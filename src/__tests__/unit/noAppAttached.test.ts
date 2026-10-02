import { describe, it, expect, afterEach } from "@jest/globals";
import { ensureConnection, noAppAttachedMessage } from "../../core/connection.js";

const realFetch = globalThis.fetch;

// Metro answering /status with an empty /json: the cold-launch window before any app attaches.
function stubMetro(status: string | null) {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
        calls.push(url);
        if (url.endsWith("/json")) return new Response("[]");
        if (status === null) throw new Error("ECONNREFUSED");
        return new Response(status);
    }) as typeof fetch;
    return calls;
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("noAppAttachedMessage", () => {
    it("says Metro is up and points at waiting, rather than reading as Metro down", async () => {
        stubMetro("packager-status:running");
        const msg = await noAppAttachedMessage(8081);
        expect(msg).toContain("Metro is running, but no app has attached yet");
        expect(msg).toContain("ensure_connection({ waitMs: 60000 })");
    });
    it("does not call a port Metro when it does not answer as Metro", async () => {
        stubMetro(null);
        expect(await noAppAttachedMessage(8082)).toContain("not answering as Metro");
    });
    it("after a wait, moves on to the next diagnostics instead of suggesting another wait", async () => {
        stubMetro("packager-status:running");
        const msg = await noAppAttachedMessage(8081, 60000);
        expect(msg).toContain("no app attached in 60s");
        expect(msg).not.toContain("waitMs");
    });
});

describe("ensure_connection waitMs", () => {
    it("keeps polling Metro for an app until the wait runs out", async () => {
        const calls = stubMetro("packager-status:running");
        const started = Date.now();
        const r = await ensureConnection({ port: 8081, waitMs: 2000 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
        expect(calls.filter((u) => u.endsWith("/json")).length).toBeGreaterThanOrEqual(3);
        expect(r.connected).toBe(false);
        expect(r.failureKind).toBe("no_debuggable_devices");
        expect(r.error).toContain("no app attached in 2s");
    });
});
