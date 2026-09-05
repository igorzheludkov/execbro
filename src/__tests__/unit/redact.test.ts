import { redactSecrets } from "../../core/redact.js";
import { resetVaultForTests, vaultAdd } from "../../core/vault.js";

const JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redactSecrets", () => {
    beforeEach(resetVaultForTests);

    it("renders a JWT as a stable handle and never as its value", () => {
        const out = redactSecrets(`token was ${JWT} ok`);
        expect(out).not.toContain(JWT);
        expect(out).toContain("[secret:jwt_app]");
    });

    it("gives the same value the same handle across two calls, which is cross-sink identity", () => {
        const fromState = redactSecrets(`{"accessToken":"${JWT}"}`);
        const fromHeader = redactSecrets(`Authorization: Bearer ${JWT}`);
        expect(fromState).toContain("[secret:jwt_app]");
        expect(fromHeader).toContain("[secret:jwt_app]");
    });

    it("masks a value seen once by exact match afterwards, with no shape or key to match", () => {
        redactSecrets("Authorization: Bearer opaque-session-id-abcdefgh");
        const later = redactSecrets('ws frame: {"t":"opaque-session-id-abcdefgh"}', { catalog: false });
        expect(later).not.toContain("opaque-session-id-abcdefgh");
        expect(later).toContain("[secret:auth_app]");
    });

    it("names a provider key by its verified shape", () => {
        expect(redactSecrets("key sk_live_51H8xKzAbCdEfGhIjKlMnOp here")).toContain("[secret:stripe_app]");
        // Exactly 20 characters: AKIA plus the 16 the regex requires, which is
        // also exactly the vault's length floor.
        expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[secret:aws_app]");
    });

    it("does not re-redact a marker a previous rule just produced", () => {
        const out = redactSecrets(`{"accessToken":"${JWT}"}`);
        expect(out).toContain('"accessToken":"[secret:jwt_app]"');
        expect(out).not.toContain("[redacted secret");
    });

    it("keeps the auth scheme but not the credential", () => {
        const out = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
        expect(out).toContain("Bearer [secret:auth_app]");
        expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
    });

    it("does not vault key-name matches, which are below the entry bar", () => {
        const out = redactSecrets("GET https://api.example.com/v1/me?access_token=s3cr3tvalue&page=2");
        expect(out).toContain("?access_token=[redacted secret,");
        expect(out).toContain("&page=2");
        expect(out).not.toContain("s3cr3tvalue");
        expect(out).not.toContain("[secret:");
    });

    it("redacts secret-named JSON fields, which covers redux state", () => {
        const out = redactSecrets('{"auth":{"access_token":"opaque-session-1234","user":"bob"}}');
        expect(out).toContain('"access_token":"[redacted secret,');
        expect(out).not.toContain("opaque-session-1234");
        expect(out).toContain('"user":"bob"');
    });

    it("no longer discloses the last four characters", () => {
        const out = redactSecrets('{"access_token":"opaque-session-1234"}');
        expect(out).not.toContain("1234]");
        expect(out).toContain("[redacted secret, 19 chars]");
    });

    it("leaves placeholders alone, because an absent token is the answer", () => {
        expect(redactSecrets("refresh_token: undefined")).toBe("refresh_token: undefined");
    });

    it("appends a catalog when a handle was emitted, and nothing otherwise", () => {
        expect(redactSecrets(`Bearer ${JWT}`)).toContain("--- secrets referenced above ---");
        expect(redactSecrets("plain text")).toBe("plain text");
    });

    it("omits the catalog when asked, for telemetry fields", () => {
        const out = redactSecrets(`Bearer ${JWT}`, { catalog: false });
        expect(out).not.toContain("--- secrets referenced above ---");
        expect(out).toContain("[secret:jwt_app]");
    });
});

describe("catalog coverage for handles emitted elsewhere", () => {
    beforeEach(resetVaultForTests);

    it("explains a handle that redactHeaderValue rendered, not this call", () => {
        // network.ts renders its own handle, so the chokepoint sees the marker
        // already in place with nothing left to match.
        const handle = vaultAdd("opaque-session-id-abcdefgh", "auth", "https://gifted.fyi/app-api/me")!;
        const out = redactSecrets(`Authorization: Bearer [secret:${handle}]`);
        expect(out).toContain("--- secrets referenced above ---");
        expect(out).toContain("auth_gifted.fyi: auth seen on gifted.fyi");
    });
});
