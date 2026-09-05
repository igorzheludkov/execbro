import { vaultAdd, vaultEntries, vaultByHandle, resetVaultForTests } from "../../core/vault.js";

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
