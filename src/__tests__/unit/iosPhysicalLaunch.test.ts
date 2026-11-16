import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * ios_launch_app / ios_terminate_app on a USB iPhone, through devicectl. No
 * device contact: exec.js is mocked. devicectl terminates by pid only, so the
 * pid comes from DVT, where 0 means "not running".
 */

const execMock = jest.fn<(file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>>();
jest.unstable_mockModule("../../core/exec.js", () => ({ execFileAsync: execMock }));
jest.unstable_mockModule("../../core/ios.js", () => ({
    defaultScreenshotPath: () => "/tmp/unused.png",
    finalizeScreenshotFile: jest.fn(),
}));

const { physicalIosLaunchApp, physicalIosTerminateApp } = await import("../../core/iosPhysical.js");

const PHONE = { udid: "00008030-001D69C00192802E", name: "iPhone", version: "27.2.1", productType: "iPhone12,1" };
const APP = "com.example.app";

function respond(pid: string, terminate?: () => never) {
    execMock.mockImplementation(async (_file, args) => {
        if (args.includes("process-id-for-bundle-id")) return { stdout: `${pid}\n`, stderr: "" };
        if (args.includes("terminate") && terminate) terminate();
        return { stdout: "", stderr: "" };
    });
}

beforeEach(() => {
    execMock.mockReset();
});

describe("physicalIosTerminateApp", () => {
    it("says not running for pid 0 and sends no signal", async () => {
        respond("0");
        const r = await physicalIosTerminateApp(PHONE, APP);
        expect(r.success).toBe(true);
        expect(r.result).toContain("was not running");
        expect(execMock.mock.calls.some(([, a]) => a.includes("terminate"))).toBe(false);
    });

    it("terminates the pid DVT reports", async () => {
        respond("1786");
        const r = await physicalIosTerminateApp(PHONE, APP);
        expect(r.success).toBe(true);
        const term = execMock.mock.calls.find(([, a]) => a.includes("terminate"))!;
        expect(term[1]).toEqual(expect.arrayContaining(["--device", PHONE.udid, "--pid", "1786"]));
    });

    it("treats an exit between lookup and signal as stopped", async () => {
        respond("1786", () => { throw new Error("ERROR: Failed to send signal 15. No such process; the process may have already terminated."); });
        const r = await physicalIosTerminateApp(PHONE, APP);
        expect(r.success).toBe(true);
        expect(r.result).toContain("exited");
    });
});

describe("physicalIosLaunchApp", () => {
    it("launches by hardware UDID and surfaces devicectl's error", async () => {
        execMock.mockRejectedValue(new Error("The requested application com.nope is not installed."));
        const r = await physicalIosLaunchApp(PHONE, "com.nope");
        expect(r.success).toBe(false);
        expect(r.error).toContain("not installed");
        expect(execMock.mock.calls[0][1]).toEqual(["devicectl", "device", "process", "launch", "--device", PHONE.udid, "-q", "com.nope"]);
    });
});
