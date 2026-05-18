import { describe, it, expect } from "@jest/globals";
import { buildRnGlobalsBootstrapExpression } from "../../core/rnGlobalsBootstrap.js";

describe("buildRnGlobalsBootstrapExpression", () => {
    it("is an IIFE", () => {
        const expr = buildRnGlobalsBootstrapExpression();
        expect(expr.trim()).toMatch(/^\(\(?function|^\(\(\)\s*=>/);
        expect(expr.trim()).toMatch(/\)\(\)$/);
    });

    it("walks the React DevTools fiber tree", () => {
        const expr = buildRnGlobalsBootstrapExpression();
        expect(expr).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
        expect(expr).toContain("getFiberRoots");
    });

    it("probes for each curated module by shape signature", () => {
        const expr = buildRnGlobalsBootstrapExpression();
        expect(expr).toContain("isRTL"); // I18nManager
        expect(expr).toContain("getFontScale"); // PixelRatio
        expect(expr).toContain("OS"); // Platform
    });

    it("assigns to globalThis.__rn__", () => {
        const expr = buildRnGlobalsBootstrapExpression();
        expect(expr).toContain("globalThis.__rn__");
    });

    it("sets __rn__ to null when no fiber yields any module", () => {
        const expr = buildRnGlobalsBootstrapExpression();
        expect(expr).toContain("globalThis.__rn__ = null");
    });
});
