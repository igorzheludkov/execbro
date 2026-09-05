import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { resolveAuth, issueHttpRequest } from "../../core/httpRequest.js";
import { vaultAdd, resetVaultForTests } from "../../core/vault.js";
import { UserInputError } from "../../core/errors.js";

const TOKEN = "opaque-session-id-abcdefgh";
/** exp = 1000000000 (year 2001). */
const DEAD_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDAwMDAwMDB9.Zm9vYmFyc2lnbmF0dXJlZm9vYmFy";

function mockFetch(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
    const res = new Response(body, {
        status: init.status ?? 200,
        headers: init.headers ?? { "content-type": "application/json" },
    });
    // Typed with fetch's own signature so the recorded call carries its init.
    const spy = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => res);
    (globalThis as unknown as { fetch: unknown }).fetch = spy;
    return spy;
}

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("resolveAuth origin binding", () => {
    beforeEach(resetVaultForTests);

    it("attaches a credential to its own origin", () => {
        vaultAdd(TOKEN, "auth", "https://api.acme.io/v1/me");
        const { header } = resolveAuth({ secret: "api.acme.io" }, "https://api.acme.io/v1/orders");
        expect(header).toBe(`Bearer ${TOKEN}`);
    });

    it("refuses to send a credential to a different origin, which is the exfiltration case", () => {
        vaultAdd(TOKEN, "auth", "https://api.acme.io/v1/me");
        expect(() => resolveAuth({ secret: "api.acme.io" }, "https://evil.com/collect")).toThrow(UserInputError);
        try {
            resolveAuth({ secret: "api.acme.io" }, "https://evil.com/collect");
        } catch (e) {
            expect((e as Error).message).toContain("api.acme.io");
            expect((e as Error).message).toContain("evil.com");
            expect((e as Error).message).not.toContain(TOKEN);
        }
    });

    it("refuses a handle pointing at another origin, so a handle is no way around binding", () => {
        const handle = vaultAdd(TOKEN, "auth", "https://api.acme.io/v1/me")!;
        expect(() => resolveAuth({ secret: handle }, "https://evil.com/collect")).toThrow(UserInputError);
    });

    it("names the unknown secret without inventing one", () => {
        expect(() => resolveAuth({ secret: "api.acme.io" }, "https://api.acme.io/x")).toThrow(/no credential/i);
    });

    it("returns a staleness note for an expired credential rather than failing silently", () => {
        vaultAdd(DEAD_JWT, "auth", "https://api.acme.io/v1/me");
        const { header, note } = resolveAuth({ secret: "api.acme.io" }, "https://api.acme.io/v1/orders");
        expect(header).toBe(`Bearer ${DEAD_JWT}`);
        expect(note).toContain("expired");
    });

    it("attaches nothing when no auth was asked for", () => {
        expect(resolveAuth(undefined, "https://api.acme.io/x")).toEqual({});
    });
});

describe("issueHttpRequest", () => {
    beforeEach(resetVaultForTests);

    it("rejects a non-HTTP scheme", async () => {
        await expect(issueHttpRequest({ method: "GET", url: "file:///etc/passwd" })).rejects.toThrow(UserInputError);
    });

    it("rejects a malformed URL", async () => {
        await expect(issueHttpRequest({ method: "GET", url: "not a url" })).rejects.toThrow(UserInputError);
    });

    it("sends the resolved credential and renders the response", async () => {
        vaultAdd(TOKEN, "auth", "https://api.acme.io/v1/me");
        const spy = mockFetch(JSON.stringify({ ok: true }));
        const out = await issueHttpRequest({
            method: "GET",
            url: "https://api.acme.io/v1/orders",
            auth: { secret: "api.acme.io" },
        });
        const init = spy.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        expect(out).toContain("200");
        expect(out).toContain('"ok":true');
    });

    it("never renders the credential it just sent", async () => {
        vaultAdd(TOKEN, "auth", "https://api.acme.io/v1/me");
        // A server that echoes the Authorization header back is exactly the
        // debugging case curl was used for, and exactly what Bash could not
        // protect: the response returns through us, so it passes the redactor.
        mockFetch(JSON.stringify({ received: { authorization: `Bearer ${TOKEN}` } }));
        const out = await issueHttpRequest({
            method: "GET",
            url: "https://api.acme.io/v1/echo",
            auth: { secret: "api.acme.io" },
        });
        expect(out).not.toContain(TOKEN);
        expect(out).toContain("[secret:auth_api.acme.io]");
    });

    it("serialises an object body as JSON and sets the content type", async () => {
        const spy = mockFetch("{}");
        await issueHttpRequest({ method: "POST", url: "https://api.acme.io/v1/x", body: { qty: 2 } });
        const init = spy.mock.calls[0][1] as RequestInit;
        expect(init.body).toBe('{"qty":2}');
        expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("sends a string body verbatim without imposing a content type", async () => {
        const spy = mockFetch("{}");
        await issueHttpRequest({
            method: "POST",
            url: "https://api.acme.io/v1/x",
            body: "a=1&b=2",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const init = spy.mock.calls[0][1] as RequestInit;
        expect(init.body).toBe("a=1&b=2");
        expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });

    it("surfaces the staleness note through the WARNING channel", async () => {
        vaultAdd(DEAD_JWT, "auth", "https://api.acme.io/v1/me");
        mockFetch(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        const out = await issueHttpRequest({
            method: "GET",
            url: "https://api.acme.io/v1/orders",
            auth: { secret: "api.acme.io" },
        });
        expect(out).toContain("WARNING:");
        expect(out).toContain("expired");
    });

    it("reports a transport failure as a message, not an unhandled rejection", async () => {
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn<() => Promise<Response>>(async () => {
            throw new Error("getaddrinfo ENOTFOUND api.acme.io");
        });
        const out = await issueHttpRequest({ method: "GET", url: "https://api.acme.io/v1/x" });
        expect(out).toContain("Request failed");
        expect(out).toContain("ENOTFOUND");
    });
});
