import { describe, it, expect, afterEach, jest } from "@jest/globals";

describe("validate payload includes usageCacheState", () => {
    const realFetch = global.fetch;

    afterEach(() => {
        global.fetch = realFetch;
        jest.resetModules();
    });

    it("sends the current cache state in the validate body", async () => {
        const calls: { url: string; body: any }[] = [];
        global.fetch = jest.fn(async (url: any, init: any) => {
            calls.push({ url: String(url), body: JSON.parse(init.body) });
            return { ok: true, status: 200, json: async () => ({ tier: "free", validatedAt: "", cacheExpiresAt: "" }) } as any;
        }) as any;

        const { refreshLicense } = await import("../../core/license.js");
        await refreshLicense();

        const validateCall = calls.find((c) => c.url.includes("/api/license/validate"));
        expect(validateCall).toBeTruthy();
        expect(["valid", "invalid_sig", "missing"]).toContain(validateCall!.body.usageCacheState);
    });
});
