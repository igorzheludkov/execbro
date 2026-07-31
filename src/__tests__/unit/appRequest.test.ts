import { describe, it, expect } from "@jest/globals";
import { buildRequestExpression } from "../../core/appRequest.js";

describe("buildRequestExpression", () => {
    it("emits Hermes-compatible ES5 only", () => {
        const src = buildRequestExpression({ method: "GET", url: "https://example.com/x" });
        expect(src).not.toMatch(/=>|\bconst\b|\blet\b|\basync\b/);
    });

    it("embeds method and url safely as JSON literals", () => {
        const src = buildRequestExpression({ method: "DELETE", url: "https://api.test/user/17?q=a&b=c" });
        expect(src).toContain('"DELETE"');
        expect(src).toContain('"https://api.test/user/17?q=a&b=c"');
    });

    it("upper-cases the method", () => {
        const src = buildRequestExpression({ method: "post", url: "https://api.test/x" });
        expect(src).toContain('"POST"');
    });

    it("never embeds a token — auth resolves in-app", () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        expect(src).toContain("accessToken");
        expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    });

    it("omits the Authorization header when auth is none", () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/public", auth: "none" });
        // The response still reports an `authorized` flag, so assert on the
        // header actually being set rather than on the word appearing at all.
        expect(src).not.toContain("'Bearer '");
        expect(src).not.toContain("accessToken");
    });

    it("serialises a JSON body and sets the content type", () => {
        const src = buildRequestExpression({ method: "POST", url: "https://api.test/x", body: { name: "Test" } });
        expect(src).toContain('"application/json"');
        expect(src).toContain('{\\"name\\":\\"Test\\"}');
    });

    it("escapes a url containing a quote rather than breaking the expression", () => {
        const src = buildRequestExpression({ method: "GET", url: 'https://api.test/a"b' });
        expect(src).toContain('\\"');
        // The generated source must still be parseable.
        expect(() => new Function("return " + src.replace(/^\(function/, "(function"))).not.toThrow();
    });

    it("passes explicit headers through", () => {
        const src = buildRequestExpression({
            method: "GET",
            url: "https://api.test/x",
            headers: { "x-lang": "en" }
        });
        expect(src).toContain('"x-lang"');
        expect(src).toContain('"en"');
    });
});

describe("buildRequestExpression — unresolved auth", () => {
    it("warns when auth=auto is requested (the note is emitted, gated at runtime)", () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        expect(src).toContain("UNAUTHENTICATED");
        expect(src).toContain("no captured request carried an Authorization header");
    });

    it("does not emit the warning when auth is explicitly none", () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/x", auth: "none" });
        expect(src).toContain("var authNote = null;");
        expect(src).not.toContain("UNAUTHENTICATED");
    });
});

describe("buildRequestExpression — generated source behaviour", () => {
    type Captured = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

    function runGenerated(
        src: string,
        stateStub: unknown,
        globalStub: Record<string, unknown> = {}
    ): Promise<{ captured: Captured; result: Record<string, unknown> }> {
        let captured: Captured | undefined;
        const fetchStub = (url: string, init: Captured["init"]) => {
            captured = { url, init };
            return Promise.resolve({
                status: 200,
                ok: true,
                text: () => Promise.resolve(JSON.stringify({ hello: "world" }))
            });
        };
        const run = new Function("state", "fetch", "globalThis", "return " + src + ";");
        return (run(stateStub, fetchStub, globalStub) as Promise<Record<string, unknown>>).then((result) => ({
            captured: captured as Captured,
            result
        }));
    }

    it("sets a bearer header from state.user.accessToken", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { captured, result } = await runGenerated(src, { user: { accessToken: "tok-123" } });
        expect(captured.init.headers.Authorization).toBe("Bearer tok-123");
        expect(result.authorized).toBe(true);
        expect(result.authNote).toBeUndefined();
    });

    it("falls back to state.auth.accessToken", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { captured } = await runGenerated(src, { auth: { accessToken: "tok-abc" } });
        expect(captured.init.headers.Authorization).toBe("Bearer tok-abc");
    });

    it("warns and sends unauthenticated when no token is present", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { captured, result } = await runGenerated(src, { auth: { isAuthenticated: true } });
        expect(captured.init.headers.Authorization).toBeUndefined();
        expect(result.authorized).toBe(false);
        expect(String(result.authNote)).toContain("UNAUTHENTICATED");
    });

    it("lets an explicit Authorization header win over auth=auto", async () => {
        const src = buildRequestExpression({
            method: "GET",
            url: "https://api.test/me",
            auth: "auto",
            headers: { Authorization: "Bearer explicit" }
        });
        const { captured, result } = await runGenerated(src, { user: { accessToken: "tok-123" } });
        expect(captured.init.headers.Authorization).toBe("Bearer explicit");
        expect(result.authNote).toBeUndefined();
    });

    it("sends the body and parses a JSON response", async () => {
        const src = buildRequestExpression({ method: "POST", url: "https://api.test/x", body: { a: 1 }, auth: "none" });
        const { captured, result } = await runGenerated(src, null);
        expect(captured.init.method).toBe("POST");
        expect(captured.init.body).toBe('{"a":1}');
        expect(captured.init.headers["Content-Type"]).toBe("application/json");
        expect(result.body).toEqual({ hello: "world" });
    });
});

describe("buildRequestExpression — token from captured requests (Apollo apps)", () => {
    type Captured = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

    function runWith(src: string, stateStub: unknown, globalStub: Record<string, unknown>) {
        let captured: Captured | undefined;
        const fetchStub = (url: string, init: Captured["init"]) => {
            captured = { url, init };
            return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve("{}") });
        };
        const run = new Function("state", "fetch", "globalThis", "return " + src + ";");
        return (run(stateStub, fetchStub, globalStub) as Promise<Record<string, unknown>>).then((result) => ({
            captured: captured as Captured,
            result
        }));
    }

    const sdkWith = (headers: Record<string, string>[]) => ({
        __RN_AI_DEVTOOLS__: {
            getNetworkEntries: () => headers.map((h) => ({ requestHeaders: h }))
        }
    });

    it("reuses the Authorization header from the most recent captured request", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { captured, result } = await runWith(src, { auth: { isAuthenticated: true } }, sdkWith([
            { Authorization: "Bearer old-token" },
            { "content-type": "application/json" },
            { authorization: "Bearer newest-token" }
        ]));
        expect(captured.init.headers.Authorization).toBe("Bearer newest-token");
        expect(result.authSource).toBe("captured-request");
        expect(result.authNote).toBeUndefined();
    });

    it("prefers redux over a captured header when both exist", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { captured, result } = await runWith(src, { user: { accessToken: "redux-tok" } }, sdkWith([
            { Authorization: "Bearer captured-tok" }
        ]));
        expect(captured.init.headers.Authorization).toBe("Bearer redux-tok");
        expect(result.authSource).toBe("redux");
    });

    it("still warns when neither redux nor any captured request has a token", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { result } = await runWith(src, null, sdkWith([{ "content-type": "application/json" }]));
        expect(result.authorized).toBe(false);
        expect(String(result.authNote)).toContain("UNAUTHENTICATED");
    });

    it("degrades quietly when the SDK is absent", async () => {
        const src = buildRequestExpression({ method: "GET", url: "https://api.test/me", auth: "auto" });
        const { result } = await runWith(src, null, {});
        expect(result.authorized).toBe(false);
        expect(String(result.authNote)).toContain("UNAUTHENTICATED");
    });

    it("reports an explicitly-passed header as the source", async () => {
        const src = buildRequestExpression({
            method: "GET",
            url: "https://api.test/me",
            auth: "auto",
            headers: { Authorization: "Bearer explicit" }
        });
        const { captured, result } = await runWith(src, { user: { accessToken: "redux-tok" } }, sdkWith([]));
        expect(captured.init.headers.Authorization).toBe("Bearer explicit");
        expect(result.authSource).toBe("explicit");
    });
});
