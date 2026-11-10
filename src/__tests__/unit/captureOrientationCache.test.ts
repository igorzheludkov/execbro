import { describe, it, expect, jest } from "@jest/globals";
import sharp from "sharp";

// Every iOS screenshot read the device orientation fresh (simctl spawn notifyutil,
// ~350ms, longer than the ~220ms capture it runs beside). A tap's before/after
// verification takes about five captures, so the orientation reads were the long pole of
// each one. Verification frames now reuse the 3s orientation cache the tap already uses
// to aim; a standalone screenshot still reads it fresh.

const commands: string[] = [];
const realExec = await import("../../core/exec.js");
const png = await sharp({ create: { width: 4, height: 8, channels: 3, background: "#fff" } }).png().toBuffer();

jest.unstable_mockModule("../../core/exec.js", () => ({
    ...realExec,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    execFileAsync: async (file: string, args: string[]) => {
        commands.push([file, ...args].join(" "));
        if (args.includes("screenshot")) {
            const { writeFile } = await import("fs/promises");
            await writeFile(args[args.length - 1], png);
        }
        if (args.includes("notifyutil")) return { stdout: "com.apple.backboardd.orientation 1", stderr: "" };
        return { stdout: "", stderr: "" };
    },
}));

const { captureScreenshot } = await import("../../pro/verifyAction.js");
const { iosScreenshot } = await import("../../core/ios.js");

const orientationReads = () => commands.filter((c) => c.includes("notifyutil")).length;

describe("orientation reads around screenshots", () => {
    it("verification captures within the cache window read the orientation once", async () => {
        commands.length = 0;

        for (let i = 0; i < 4; i++) expect(await captureScreenshot("ios", "UDID-1")).not.toBeNull();

        expect(orientationReads()).toBe(1);
    });

    it("a standalone screenshot still reads it fresh", async () => {
        commands.length = 0;

        await iosScreenshot(undefined, "UDID-1");
        await iosScreenshot(undefined, "UDID-1");

        expect(orientationReads()).toBe(2);
    });
});
