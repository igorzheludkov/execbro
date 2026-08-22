import { jest, describe, it, expect, beforeEach } from "@jest/globals";

/**
 * `/api/accounts/activate` returns 200 whenever the token is valid and the
 * account gets linked, including when that account has no Pro subscription.
 * The old message said "License activated. You're now on the free plan." for
 * that case, which reads as a completed upgrade while the caller's entitlement
 * did not change — and someone already at the cap keeps getting blocked right
 * after being told activation worked. Observed on 2026-08-22 against a
 * linked-but-free stage account.
 */
const getUsageInfo = jest.fn<any>();
const getDashboardUrl = jest.fn<any>();

// The whole export surface of license.js: accountTools pulls it in through a
// chain that reaches every one of these, and a missing name fails module
// linking rather than the assertion under test.
jest.unstable_mockModule("../../core/license.js", () => ({
    getUsageInfo,
    getDashboardUrl,
    GRACE_WINDOW_MS: 0,
    computeOfflineUsage: jest.fn(),
    ensureLicense: jest.fn(),
    formatPlanPrice: jest.fn(),
    getLicenseStatus: jest.fn(),
    getPricingInfo: jest.fn(),
    incrementLocalUsage: jest.fn(),
    refreshLicense: jest.fn(),
    requestLinkToken: jest.fn(),
    resetLicense: jest.fn(),
}));

jest.unstable_mockModule("../../pro/usageGate.js", () => ({
    freezeSessionVerdict: jest.fn(),
    isToolBlocked: jest.fn(),
    refreezeSessionVerdict: jest.fn(),
    resetGateForTests: jest.fn(),
    usageWarningLine: jest.fn(),
}));

const { describeActivation } = await import("../../tools/accountTools.js");

describe("describeActivation", () => {
    beforeEach(() => {
        getUsageInfo.mockReset();
        getDashboardUrl.mockReset();
        getDashboardUrl.mockReturnValue("https://stage.execbro.com");
    });

    it("confirms plainly on pro and says nothing about caps", () => {
        getUsageInfo.mockReturnValue(null);

        const text = describeActivation("pro");

        expect(text).toBe("License activated. You're now on the Pro plan.");
        expect(text).not.toMatch(/cap/i);
    });

    it("does not claim an upgrade when the linked account is free", () => {
        getUsageInfo.mockReturnValue({ used: 2496, limit: 600, canUse: false, resetsAt: "2026-09-01T00:00:00.000Z" });

        const text = describeActivation("free");

        // The regression that matters: this string must not read as a completed upgrade.
        expect(text).not.toMatch(/License activated/i);
        expect(text).toMatch(/no active Pro subscription/i);
        expect(text).toMatch(/2496\/600/);
    });

    it("says calls stay blocked when the cap is already reached", () => {
        getUsageInfo.mockReturnValue({ used: 2496, limit: 600, canUse: false, resetsAt: "2026-09-01T00:00:00.000Z" });

        expect(describeActivation("free")).toMatch(/stay blocked/i);
    });

    it("omits the blocked warning while the caller still has calls left", () => {
        getUsageInfo.mockReturnValue({ used: 12, limit: 600, canUse: true, resetsAt: "2026-09-01T00:00:00.000Z" });

        const text = describeActivation("free");

        expect(text).toMatch(/12\/600/);
        expect(text).not.toMatch(/stay blocked/i);
    });

    it("still explains itself when no usage verdict is available", () => {
        getUsageInfo.mockReturnValue(null);

        const text = describeActivation("free");

        expect(text).toMatch(/no active Pro subscription/i);
        expect(text).toMatch(/stage\.execbro\.com\/pricing/);
    });
});
