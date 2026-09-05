import { describe, it, expect, beforeEach } from "@jest/globals";
import { vaultAdd, vaultResolve, vaultStaleness, vaultCatalogLine, resetVaultForTests } from "../../core/vault.js";

/** exp = 2000000000 (year 2033). */
const LIVE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsImV4cCI6MjAwMDAwMDAwMH0.Zm9vYmFyc2lnbmF0dXJl";
/** exp = 1000000000 (year 2001). */
const DEAD_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDAwMDAwMDB9.Zm9vYmFyc2lnbmF0dXJlZm9vYmFy";

describe("vault slots", () => {
    beforeEach(resetVaultForTests);

    it("resolves a slot to the most recently observed value for that origin", () => {
        vaultAdd("first-token-aaaaaaaaaaaa", "auth", "https://api.acme.io/v1/a");
        vaultAdd("second-token-bbbbbbbbbbb", "auth", "https://api.acme.io/v1/b");
        expect(vaultResolve("api.acme.io")!.value).toBe("second-token-bbbbbbbbbbb");
    });

    it("supersedes rather than accumulates, so a re-login needs no agent action", () => {
        vaultAdd("stale-token-aaaaaaaaaaaaa", "auth", "api.acme.io");
        const handle = vaultAdd("fresh-token-bbbbbbbbbbbbb", "auth", "api.acme.io")!;
        expect(vaultResolve("api.acme.io")!.handle).toBe(handle);
    });

    it("resolves a handle too, since that is what the agent actually sees in output", () => {
        const handle = vaultAdd("first-token-aaaaaaaaaaaa", "auth", "api.acme.io")!;
        vaultAdd("second-token-bbbbbbbbbbb", "auth", "api.acme.io");
        // The handle names one specific value; the slot names the newest.
        expect(vaultResolve(handle)!.value).toBe("first-token-aaaaaaaaaaaa");
        expect(vaultResolve("api.acme.io")!.value).toBe("second-token-bbbbbbbbbbb");
    });

    it("accepts a full URL as a slot name", () => {
        vaultAdd("first-token-aaaaaaaaaaaa", "auth", "api.acme.io");
        expect(vaultResolve("https://api.acme.io/v1/me")).toBeDefined();
    });

    it("returns undefined for an unknown name rather than throwing", () => {
        expect(vaultResolve("nope.example.com")).toBeUndefined();
    });

    it("reports staleness for an expired entry and stays quiet for a live one", () => {
        const dead = vaultAdd(DEAD_JWT, "auth", "api.acme.io")!;
        const live = vaultAdd(LIVE_JWT, "auth", "other.acme.io")!;
        expect(vaultStaleness(vaultResolve(dead)!)).toContain("expired");
        expect(vaultStaleness(vaultResolve(live)!)).toBeUndefined();
    });

    it("renders one catalog row without the value or any claim", () => {
        const handle = vaultAdd(LIVE_JWT, "auth", "api.acme.io")!;
        const line = vaultCatalogLine(vaultResolve(handle)!, Date.now());
        expect(line).toContain("auth_api.acme.io");
        expect(line).toContain("api.acme.io");
        expect(line).not.toContain(LIVE_JWT);
        expect(line).not.toContain("12345");
    });
});
