// Fails when tools.json drifts from the live registry — i.e. someone added or
// removed a tool without re-running `npm run tools:json`. The website vendors
// this file to validate its /readme/tools reference, so stale output silently
// ships a wrong tool list to users.

// IMPORTANT: set test mode BEFORE importing src/index.ts so main() is skipped
// (no license check, no transport, no HTTP listener, no CDP sockets).
process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolRegistry } from "../../index.js";

describe("tools.json", () => {
    const payload = JSON.parse(readFileSync(join(process.cwd(), "tools.json"), "utf8")) as {
        count: number;
        tools: string[];
    };

    it("lists exactly the registered tools", () => {
        expect(payload.tools).toEqual([...toolRegistry.keys()].sort());
    });

    it("records a count matching its own list", () => {
        expect(payload.count).toBe(payload.tools.length);
    });

    it("is not empty", () => {
        expect(payload.tools.length).toBeGreaterThan(0);
    });
});
