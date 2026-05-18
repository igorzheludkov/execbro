import { describe, expect, it } from "@jest/globals";
import {
    HMR_LOG_GLOBAL,
    HMR_LOG_CAP,
    buildRecorderInstallExpression,
    buildReadRefreshLogExpression,
} from "../../core/fastRefreshRecorder.js";

describe("constants", () => {
    it("exposes the buffer global name and cap", () => {
        expect(HMR_LOG_GLOBAL).toBe("__rn_devtools_hmr_log__");
        expect(HMR_LOG_CAP).toBe(32);
    });
});

describe("buildRecorderInstallExpression", () => {
    it("is an IIFE", () => {
        const expr = buildRecorderInstallExpression();
        expect(expr.trim()).toMatch(/^\(\(\)\s*=>\s*\{/);
        expect(expr.trim()).toMatch(/\}\)\(\)$/);
    });

    it("references __ReactRefresh (verified hook on RN 19.2.0)", () => {
        expect(buildRecorderInstallExpression()).toContain("__ReactRefresh");
    });

    it("falls back to $RefreshReg$", () => {
        expect(buildRecorderInstallExpression()).toContain("$RefreshReg$");
    });

    it("writes to the agreed global name", () => {
        expect(buildRecorderInstallExpression()).toContain(HMR_LOG_GLOBAL);
    });

    it("trims the ring buffer to HMR_LOG_CAP", () => {
        expect(buildRecorderInstallExpression()).toContain("32");
    });

    it("returns { installed, via, reason } from the IIFE", () => {
        const expr = buildRecorderInstallExpression();
        expect(expr).toMatch(/installed:\s*(true|false)/);
        expect(expr).toContain("via");
    });

    it("is idempotent — checks for existing buffer before installing", () => {
        const expr = buildRecorderInstallExpression();
        expect(expr).toContain("__rn_devtools_hmr_via__");
    });
});

describe("buildReadRefreshLogExpression", () => {
    it("installs-if-missing then reads", () => {
        const expr = buildReadRefreshLogExpression();
        expect(expr).toContain("__ReactRefresh");
        expect(expr).toContain(HMR_LOG_GLOBAL);
    });

    it("returns { lastUpdateAt, updateCount, recentUpdates, _meta }", () => {
        const expr = buildReadRefreshLogExpression();
        expect(expr).toContain("lastUpdateAt");
        expect(expr).toContain("updateCount");
        expect(expr).toContain("recentUpdates");
        expect(expr).toContain("justInstalled");
    });

    it("applies sincePath substring filter when provided", () => {
        const expr = buildReadRefreshLogExpression("language-list-item");
        expect(expr).toContain(`"language-list-item"`);
        expect(expr).toMatch(/indexOf|includes/);
    });

    it("applies since epoch filter when provided", () => {
        const expr = buildReadRefreshLogExpression(undefined, 1234567890);
        expect(expr).toContain("1234567890");
    });

    it("slices recentUpdates to the last 5 newest-first", () => {
        const expr = buildReadRefreshLogExpression();
        expect(expr).toMatch(/slice\(-5\)|slice\(0,\s*5\)/);
        expect(expr).toContain("reverse");
    });

    it("rejects sincePath containing a double-quote (string-literal injection guard)", () => {
        expect(() => buildReadRefreshLogExpression('"; drop"')).toThrow();
    });
});
