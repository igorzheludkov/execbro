import { describe, it, expect, beforeEach, jest } from "@jest/globals";

type ExecResult = { success: boolean; result?: string; error?: string };
const executeInApp = jest.fn<(...args: unknown[]) => Promise<ExecResult>>();
jest.unstable_mockModule("../../core/jsExecute.js", () => ({ executeInApp }));

const { captureToVault } = await import("../../core/vaultCapture.js");
const { resetVaultForTests, vaultResolve } = await import("../../core/vault.js");

const TOKEN = "captured-token-abcdefghijkl";

describe("captureToVault", () => {
    beforeEach(() => {
        resetVaultForTests();
        executeInApp.mockReset();
    });

    it("stores the value and returns only a handle", async () => {
        executeInApp.mockResolvedValue({ success: true, result: TOKEN });
        const out = await captureToVault("SecureStore.getItemAsync('access_token')", "https://api.acme.io");
        expect(out).toContain("[secret:auth_api.acme.io]");
        expect(out).not.toContain(TOKEN);
        expect(vaultResolve("api.acme.io")!.value).toBe(TOKEN);
    });

    it("unwraps a JSON-quoted string, which is how the runtime returns one", async () => {
        executeInApp.mockResolvedValue({ success: true, result: JSON.stringify(TOKEN) });
        await captureToVault("x", "https://api.acme.io");
        expect(vaultResolve("api.acme.io")!.value).toBe(TOKEN);
    });

    it("refuses a value below the vault's length floor instead of pretending it worked", async () => {
        executeInApp.mockResolvedValue({ success: true, result: "short" });
        const out = await captureToVault("x", "https://api.acme.io");
        expect(out).toContain("too short");
        expect(vaultResolve("api.acme.io")).toBeUndefined();
    });

    it("reports an empty result plainly", async () => {
        executeInApp.mockResolvedValue({ success: true, result: "null" });
        const out = await captureToVault("x", "https://api.acme.io");
        expect(out).toContain("no value");
        expect(vaultResolve("api.acme.io")).toBeUndefined();
    });

    it("never echoes the expression back, since that is what leaked to telemetry before", async () => {
        executeInApp.mockResolvedValue({ success: false, error: "ReferenceError: SecureStore is not defined" });
        const out = await captureToVault("SecureStore.getItemAsync('access_token')", "https://api.acme.io");
        expect(out).toContain("ReferenceError");
        expect(out).not.toContain("getItemAsync");
    });

    it("requires an absolute origin so the handle is bindable later", async () => {
        executeInApp.mockResolvedValue({ success: true, result: TOKEN });
        await expect(captureToVault("x", "not a url")).rejects.toThrow(/origin/i);
    });
});
