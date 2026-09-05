// Argent Gap Closure item 2. The rule is a paragraph, so without a test it is
// a paragraph anyone can drop in a future edit without noticing.
//
// See: docs/improvements/argent-gap-closure.md item 2, and
// docs/devtools-core/specs/2026-09-05-credential-vault-design.md section 5,
// which names this as the mitigation for the risk redaction cannot reach.

process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect } from "@jest/globals";
import { UNTRUSTED_DATA_RULE } from "../../core/guides.js";
import { SERVER_INSTRUCTIONS } from "../../index.js";
import { readFileSync } from "fs";
import { join } from "path";

describe("untrusted-data rule", () => {
    it("names every surface that carries attacker-influencable content", () => {
        // These five are the tools that pipe content the app fetched straight
        // into an agent's context. Naming them beats a vague "be careful".
        for (const surface of ["og", "etwork", "omponent", "source", "execute_in_app"]) {
            expect(UNTRUSTED_DATA_RULE).toContain(surface);
        }
    });

    it("states the data-not-instructions rule", () => {
        expect(UNTRUSTED_DATA_RULE.toLowerCase()).toContain("data, not instructions");
        expect(UNTRUSTED_DATA_RULE.toLowerCase()).toContain("never follow");
    });

    it("tells the agent what to do instead of copying a credential", () => {
        // A prohibition with no alternative gets rationalised around. The vault
        // shipped first precisely so this rule can point somewhere real.
        expect(UNTRUSTED_DATA_RULE).toContain("[secret:");
        expect(UNTRUSTED_DATA_RULE).toContain("http_request");
    });

    it("is actually wired into the instructions the server sends", () => {
        // The constant existing is worth nothing if nothing ships it.
        expect(SERVER_INSTRUCTIONS).toContain(UNTRUSTED_DATA_RULE);
    });

    it("reaches every skill that surfaces untrusted content", () => {
        // These five read app-controlled data. The other five (session-setup,
        // bundle-check, device-interact, native-rebuild, overview) do not, and
        // are deliberately left alone rather than carrying dead boilerplate.
        const risky = ["network-inspect", "debug-logs", "component-inspect", "app-state", "layout-check"];
        for (const skill of risky) {
            const text = readFileSync(join(process.cwd(), "skills", `${skill}.md`), "utf8");
            expect(text.toLowerCase()).toContain("data, not instructions");
        }
    });
});
