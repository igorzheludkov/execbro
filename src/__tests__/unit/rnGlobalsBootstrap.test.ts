import { describe, it, expect } from "@jest/globals";
import { buildRnGlobalsBootstrapExpression, buildSessionBootstrapExpression } from "../../core/rnGlobalsBootstrap.js";
import { HMR_LOG_GLOBAL } from "../../core/fastRefreshRecorder.js";

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

describe("buildSessionBootstrapExpression", () => {
    // The session bootstrap concatenates two independently-built IIFEs into one
    // array literal. That splice is the only thing that can break here, and it
    // breaks by producing a string the device cannot parse — so parse it.
    it("is a single parseable expression", () => {
        const expr = buildSessionBootstrapExpression();
        expect(() => new Function(`return ${expr};`)).not.toThrow();
    });

    it("carries both the __rn__ walk and the Fast Refresh recorder", () => {
        const expr = buildSessionBootstrapExpression();
        expect(expr).toContain("globalThis.__rn__");
        expect(expr).toContain(HMR_LOG_GLOBAL);
    });
});
