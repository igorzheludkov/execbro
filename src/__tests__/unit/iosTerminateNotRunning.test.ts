import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * `simctl terminate` on an app that is not running exits 3 with "found nothing
 * to terminate". The caller asked for the app to be stopped and it is stopped,
 * so that is the outcome they wanted — every one of the 13 ios_terminate_app
 * failures in the week to 2026-09-19 was this, on an app that had already exited.
 */

const execFileAsyncMock =
    jest.fn<(file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>>();

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execFileAsyncMock,
    quoteForDeviceShell: (value: string) => `'${value}'`,
    execAsync: jest.fn(),
    withCancelableTimeout: jest.fn(),
}));

const { iosTerminateApp } = await import("../../core/ios.js");

const UDID = "F93612A3-0042-4BDC-855F-8CAB1BDD76C6";

beforeEach(() => {
    execFileAsyncMock.mockReset();
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
});

function failTerminateWith(message: string) {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
        if (args.includes("terminate")) throw new Error(message);
        return { stdout: "", stderr: "" };
    });
}

describe("iosTerminateApp", () => {
    it("reports success when there was nothing to terminate", async () => {
        failTerminateWith(
            "Command failed: xcrun simctl terminate " + UDID + " com.example.app\n" +
            "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\n" +
            "Simulator device failed to terminate com.example.app.\nfound nothing to terminate"
        );
        const r = await iosTerminateApp("com.example.app", UDID);
        expect(r.success).toBe(true);
        // Never claims a termination happened: simctl gives this same error for
        // a bundle id that is not installed at all, so the result says what is
        // actually known.
        expect(String(r.result)).toContain("was not running");
        expect(String(r.result)).toContain("check the bundle id");
    });

    it("still fails on a real terminate error", async () => {
        failTerminateWith("Command failed: Invalid device: nope");
        const r = await iosTerminateApp("com.example.app", UDID);
        expect(r.success).toBe(false);
        expect(String(r.error)).toContain("Failed to terminate app");
    });
});
