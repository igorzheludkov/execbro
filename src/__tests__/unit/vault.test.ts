import { vaultAdd, vaultEntries, vaultByHandle, resetVaultForTests, vaultMaskExact, vaultCatalog, vaultHandleRef } from "../../core/vault.js";

// exp = 2000000000 (2033), no other claims read.
const JWT_EXP =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsImVtYWlsIjoiYUBiLmMiLCJleHAiOjIwMDAwMDAwMDB9.Zm9vYmFyc2lnbmF0dXJl";

describe("vault", () => {
    beforeEach(resetVaultForTests);

    it("gives the same value the same handle every time", () => {
        const a = vaultAdd("abcdefghijklmnopqrstuvwxyz", "jwt", "api.acme.io");
        const b = vaultAdd("abcdefghijklmnopqrstuvwxyz", "jwt", "api.acme.io");
        expect(a).toBe("jwt_api.acme.io");
        expect(b).toBe(a);
        expect(vaultEntries()).toHaveLength(1);
    });

    it("suffixes a second distinct value at the same position", () => {
        const a = vaultAdd("aaaaaaaaaaaaaaaaaaaaaaaa", "jwt", "api.acme.io");
        const b = vaultAdd("bbbbbbbbbbbbbbbbbbbbbbbb", "jwt", "api.acme.io");
        expect(a).toBe("jwt_api.acme.io");
        expect(b).toBe("jwt_api.acme.io#2");
    });

    it("names an origin-less value after the app", () => {
        expect(vaultAdd("aaaaaaaaaaaaaaaaaaaaaaaa", "jwt")).toBe("jwt_app");
    });

    it("accepts a full URL as the origin and keys on its host", () => {
        expect(vaultAdd("aaaaaaaaaaaaaaaaaaaaaaaa", "auth", "https://api.acme.io/v1/me?page=2"))
            .toBe("auth_api.acme.io");
    });

    it("refuses values below the 20 character floor", () => {
        expect(vaultAdd("short", "jwt", "api.acme.io")).toBeUndefined();
        expect(vaultEntries()).toHaveLength(0);
    });

    it("derives exp from a JWT and stores no other claim", () => {
        const handle = vaultAdd(JWT_EXP, "jwt", "api.acme.io")!;
        const entry = vaultByHandle(handle)!;
        expect(entry.expiresAt).toBe(2000000000 * 1000);
        expect(JSON.stringify(entry)).not.toContain("12345");
        expect(JSON.stringify(entry)).not.toContain("a@b.c");
    });

    it("derives no expiry from a non-JWT kind", () => {
        const handle = vaultAdd(JWT_EXP, "credential", "api.acme.io")!;
        expect(vaultByHandle(handle)!.expiresAt).toBeUndefined();
    });

    it("evicts the oldest entry past the cap and never reuses its handle", () => {
        for (let i = 0; i < 205; i++) vaultAdd(`value-padding-${String(i).padStart(10, "0")}`, "jwt");
        expect(vaultEntries().length).toBeLessThanOrEqual(200);
        const fresh = vaultAdd("value-padding-0000000000", "jwt");
        expect(fresh).toBe("jwt_app#206");
    });
});

describe("vaultMaskExact", () => {
    beforeEach(resetVaultForTests);

    it("masks a vaulted value anywhere it later appears", () => {
        vaultAdd("opaque-session-id-abcdefgh", "credential", "api.acme.io");
        const hits = new Set<string>();
        const out = vaultMaskExact("log line sid=opaque-session-id-abcdefgh done", hits);
        expect(out).toBe("log line sid=[secret:credential_api.acme.io] done");
        expect([...hits]).toEqual(["credential_api.acme.io"]);
    });

    it("masks every occurrence, not just the first", () => {
        vaultAdd("opaque-session-id-abcdefgh", "credential");
        const out = vaultMaskExact("a opaque-session-id-abcdefgh b opaque-session-id-abcdefgh", new Set());
        expect(out).not.toContain("opaque-session-id-abcdefgh");
        expect(out.match(/\[secret:credential_app\]/g)).toHaveLength(2);
    });

    it("prefers the longer value when one vaulted value contains another", () => {
        vaultAdd("aaaaaaaaaaaaaaaaaaaaaaaa", "credential");
        vaultAdd("aaaaaaaaaaaaaaaaaaaaaaaaEXTRAEXTRA", "credential");
        const out = vaultMaskExact("v=aaaaaaaaaaaaaaaaaaaaaaaaEXTRAEXTRA", new Set());
        expect(out).toBe("v=[secret:credential_app#2]");
    });

    it("leaves text with no vaulted value untouched and records no hits", () => {
        vaultAdd("aaaaaaaaaaaaaaaaaaaaaaaa", "credential");
        const hits = new Set<string>();
        expect(vaultMaskExact("nothing to see", hits)).toBe("nothing to see");
        expect(hits.size).toBe(0);
    });
});

describe("vaultCatalog", () => {
    beforeEach(resetVaultForTests);

    it("is empty when nothing was referenced", () => {
        expect(vaultCatalog(new Set())).toBe("");
    });

    it("lists origin and kind but never the value or a claim", () => {
        const handle = vaultAdd(JWT_EXP, "jwt", "api.acme.io")!;
        const out = vaultCatalog(new Set([handle]));
        expect(out).toContain("--- secrets referenced above ---");
        expect(out).toContain("jwt_api.acme.io: jwt seen on api.acme.io");
        expect(out).not.toContain(JWT_EXP);
        expect(out).not.toContain("12345");
        expect(out).not.toContain("a@b.c");
    });

    it("marks an expired entry", () => {
        // exp = 1000000000 (2001).
        const expired = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDAwMDAwMDB9.Zm9vYmFyc2lnbmF0dXJlZm9vYmFy";
        const handle = vaultAdd(expired, "jwt", "api.acme.io")!;
        expect(vaultCatalog(new Set([handle]))).toContain("EXPIRED");
    });

    it("renders a handle reference in one place only", () => {
        expect(vaultHandleRef("jwt_api.acme.io")).toBe("[secret:jwt_api.acme.io]");
    });
});
