import { describe, it, expect } from "@jest/globals";
import { resolveApiBaseUrl } from "../../core/config.js";

const PROD = "https://execbro.com";
const LOCAL = "http://localhost:3000";
const FAKE = "http://localhost:9999";

describe("resolveApiBaseUrl", () => {
    it("published build ignores the EXECBRO_API_URL override", () => {
        const r = resolveApiBaseUrl({ envUrl: FAKE, published: true, devMode: false });
        expect(r.url).toBe(PROD);
        expect(r.overrideIgnored).toBe(true);
    });

    it("published build ignores the config.json apiUrl override", () => {
        const r = resolveApiBaseUrl({ configUrl: FAKE, published: true, devMode: false });
        expect(r.url).toBe(PROD);
        expect(r.overrideIgnored).toBe(true);
    });

    it("published build with no override uses production silently", () => {
        const r = resolveApiBaseUrl({ published: true, devMode: false });
        expect(r.url).toBe(PROD);
        expect(r.overrideIgnored).toBe(false);
    });

    it("source checkout honors the env override", () => {
        const r = resolveApiBaseUrl({ envUrl: FAKE, published: false, devMode: false });
        expect(r.url).toBe(FAKE);
        expect(r.overrideIgnored).toBe(false);
    });

    it("source checkout honors the config.json override", () => {
        const r = resolveApiBaseUrl({ configUrl: FAKE, published: false, devMode: false });
        expect(r.url).toBe(FAKE);
        expect(r.overrideIgnored).toBe(false);
    });

    it("env override wins over config.json in a checkout", () => {
        const r = resolveApiBaseUrl({ envUrl: FAKE, configUrl: "http://other", published: false, devMode: false });
        expect(r.url).toBe(FAKE);
    });

    it("dev-server.sh case: checkout, --http, env pinned to production", () => {
        const r = resolveApiBaseUrl({ envUrl: PROD, published: false, devMode: true });
        expect(r.url).toBe(PROD);
        expect(r.overrideIgnored).toBe(false);
    });

    it("checkout in --http mode with no override defaults to localhost", () => {
        const r = resolveApiBaseUrl({ published: false, devMode: true });
        expect(r.url).toBe(LOCAL);
    });

    it("empty-string overrides are treated as absent, not as a redirect", () => {
        expect(resolveApiBaseUrl({ envUrl: "", published: true, devMode: false }).overrideIgnored).toBe(false);
        expect(resolveApiBaseUrl({ envUrl: "", published: false, devMode: false }).url).toBe(PROD);
    });
});
