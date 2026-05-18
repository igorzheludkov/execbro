import { describe, it, expect } from "@jest/globals";
import { buildListDebugGlobalsExpression } from "../../core/debugGlobals.js";

describe("buildListDebugGlobalsExpression", () => {
    it("probes globalThis.__rn__ and surfaces its keys", () => {
        const expr = buildListDebugGlobalsExpression();
        expect(expr).toContain("__rn__");
        expect(expr).toMatch(/rn\s*:/);
    });

    it("emits a hint that mentions globalThis.__rn__", () => {
        const expr = buildListDebugGlobalsExpression();
        expect(expr).toContain("globalThis.__rn__");
    });
});
