// IMPORTANT: set test mode BEFORE importing src/index.ts so main() is skipped
// (no license check, no transport, no HTTP listener, no CDP sockets).
process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect, beforeEach } from "@jest/globals";
import { toolRegistry } from "../../index.js";
import { vaultAdd, resetVaultForTests } from "../../core/vault.js";

describe("Phase 2 tool surface", () => {
    beforeEach(resetVaultForTests);

    it("registers all three tools", () => {
        expect(toolRegistry.has("http_request")).toBe(true);
        expect(toolRegistry.has("vault_capture")).toBe(true);
        expect(toolRegistry.has("list_secrets")).toBe(true);
    });

    it("states the in-app versus from-host distinction on both request tools", () => {
        const host = toolRegistry.get("http_request")!.config.description as string;
        const app = toolRegistry.get("app_request")!.config.description as string;
        expect(host.toLowerCase()).toContain("from the host");
        expect(host).toContain("app_request");
        expect(app).toContain("http_request");
    });

    it("keeps execute_in_app free of any credential parameter", () => {
        // The refusal must stay the absence of a feature, not a special case.
        const schema = toolRegistry.get("execute_in_app")!.config.inputSchema as Record<string, unknown>;
        expect(Object.keys(schema)).not.toContain("auth");
        expect(Object.keys(schema)).not.toContain("secret");
    });

    it("lists captured secrets without any value", async () => {
        vaultAdd("opaque-session-id-abcdefgh", "auth", "https://api.acme.io/v1/me");
        const out = await toolRegistry.get("list_secrets")!.handler({});
        const text = out.content[0].text as string;
        expect(text).toContain("auth_api.acme.io");
        expect(text).not.toContain("opaque-session-id-abcdefgh");
    });

    it("says so plainly when the vault is empty", async () => {
        const out = await toolRegistry.get("list_secrets")!.handler({});
        expect(out.content[0].text).toContain("No credentials captured");
    });
});
