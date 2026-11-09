import { WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { createWebSocketWithOriginFallback, describeConnectionFailure, originCandidates } from "../../core/connection.js";

describe("originCandidates", () => {
    it("puts 127.0.0.1 first for a loopback host (Expo CLI rejects localhost), then the derived Origin, then none", () => {
        expect(originCandidates("ws://localhost:8081/inspector/debug?device=d&page=1")).toEqual([
            "http://127.0.0.1:8081",
            "http://localhost:8081",
            undefined,
        ]);
    });

    it("does not repeat an Origin when the host already is 127.0.0.1", () => {
        expect(originCandidates("ws://127.0.0.1:8081/hot")).toEqual(["http://127.0.0.1:8081", undefined]);
    });

    it("keeps a LAN or tunnel host's own Origin", () => {
        expect(originCandidates("ws://192.168.0.5:8081/hot")).toEqual(["http://192.168.0.5:8081", undefined]);
    });
});

type Policy = (origin: string | undefined) => "accept" | "close" | "401";

// Stand-ins for the Metro variants measured on 2026-11-09 (Expo SDK 52-58, bare RN 0.85 and 0.88).
const expoCli58: Policy = (o) => (o === "http://127.0.0.1:PORT" ? "accept" : o ? "close" : "401");
const expoCli55: Policy = (o) => (o === undefined || o === "http://127.0.0.1:PORT" ? "accept" : "close");
const bareRn: Policy = (o) => (o === undefined ? "401" : "accept");

async function serve(policy: Policy) {
    const seen: Array<string | undefined> = [];
    const wss: WebSocketServer = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        verifyClient: (info, done) => {
            const port = (wss.address() as AddressInfo).port;
            const origin = info.origin || undefined;
            seen.push(origin);
            const verdict = policy(origin?.replace(`:${port}`, ":PORT"));
            if (verdict === "401") done(false, 401, "Unauthorized");
            else done(true);
        },
    });
    wss.on("connection", (ws, req) => {
        const port = (wss.address() as AddressInfo).port;
        const origin = req.headers.origin?.replace(`:${port}`, ":PORT");
        if (policy(origin) === "close") ws.terminate();
    });
    await new Promise((r) => wss.once("listening", r));
    return { wss, seen, url: `ws://localhost:${(wss.address() as AddressInfo).port}/inspector/debug` };
}

describe("createWebSocketWithOriginFallback against Metro variants", () => {
    const cases: Array<[string, Policy]> = [
        ["Expo CLI 58 (only 127.0.0.1)", expoCli58],
        ["Expo CLI 52-55 (127.0.0.1 or none)", expoCli55],
        ["bare RN 0.85 / 0.88 (any Origin, not none)", bareRn],
    ];
    it.each(cases)("connects to %s", async (_name, policy) => {
        const { wss, seen, url } = await serve(policy);
        const ws = await createWebSocketWithOriginFallback(url);
        expect(ws.readyState).toBe(ws.OPEN);
        expect(seen[0]).toBe(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`);
        expect(seen).toHaveLength(1); // first candidate wins everywhere: no fallback round-trips
        ws.close();
        wss.close();
    });

    it("falls back to the URL-derived Origin, then to none, for a Metro that wants one of those", async () => {
        const onlyLocalhost: Policy = (o) => (o === "http://localhost:PORT" ? "accept" : "close");
        const a = await serve(onlyLocalhost);
        const wsA = await createWebSocketWithOriginFallback(a.url);
        expect(a.seen).toHaveLength(2);
        wsA.close();
        a.wss.close();

        const onlyNone: Policy = (o) => (o === undefined ? "accept" : "close");
        const b = await serve(onlyNone);
        const wsB = await createWebSocketWithOriginFallback(b.url);
        expect(b.seen[2]).toBeUndefined();
        wsB.close();
        b.wss.close();
    });

    it("reports every attempt when all fail, and says a local Metro is not behind a proxy", async () => {
        const { wss, url } = await serve((o) => (o ? "close" : "401"));
        const err = await createWebSocketWithOriginFallback(url).then(
            () => null,
            (e: Error) => e,
        );
        expect(err?.message).toContain("401");
        expect(err?.message).toContain("earlier attempts");
        expect(err?.message).toContain("Origin http://127.0.0.1");
        const text = describeConnectionFailure(err!.message, url);
        expect(text).toContain("This Metro is local");
        expect(text).not.toContain("authenticating proxy");
        wss.close();
    });
});

describe("describeConnectionFailure host awareness", () => {
    it("keeps the proxy guidance for a non-local host or no url", () => {
        expect(describeConnectionFailure("Unexpected server response: 401", "ws://metro.corp.example:8081/hot")).toContain("authenticating proxy");
        expect(describeConnectionFailure("Unexpected server response: 401")).toContain("authenticating proxy");
    });
});
