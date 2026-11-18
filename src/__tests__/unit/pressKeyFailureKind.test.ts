import { describe, it, expect, jest } from "@jest/globals";

/**
 * AXe's "Failed to load essential private frameworks" means the driver cannot work on this machine, and press_key reported it with no failure kind, so it counted as a tool defect. The exec layer is stubbed: nothing touches a simulator.
 */

const UDID = "F93612A3-0042-4BDC-855F-8CAB1BDD76C6";

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[]) => {
        if (file === "axe" && args[0] !== "--version") {
            throw Object.assign(new Error(`Command failed: axe ${args.join(" ")}`), {
                cmd: `axe ${args.join(" ")}`,
                stderr: "Error: Failed to load essential private frameworks: CoreSimulator",
                code: 1,
                killed: false,
            });
        }
        return { stdout: "", stderr: "" };
    },
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T>(p: Promise<T>) => p,
}));

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: async () => ({ ok: true, target: { platform: "ios", iosUdid: UDID, deviceName: "iPhone 17", source: "udid" } }),
    formatResolverError: (e: { message: string }) => e.message,
}));

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>();
jest.unstable_mockModule("../../core/register.js", () => ({
    registerToolWithTelemetry: (_s: unknown, name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<any>) => {
        handlers.set(name, handler);
    },
    toolRegistry: new Map(),
}));

const { registerInteractionTools } = await import("../../tools/interactionTools.js");
registerInteractionTools({ registerTool: () => {} } as never);

describe("press_key on a simulator AXe cannot drive", () => {
    it("forwards driver_not_installed with the fix", async () => {
        const r = await handlers.get("press_key")!({ key: "Enter", device: UDID });

        expect(r.isError).toBe(true);
        expect(r._failureKind).toBe("driver_not_installed");
        expect(r.content[0].text).toMatch(/xcode-select/);
    });
});
