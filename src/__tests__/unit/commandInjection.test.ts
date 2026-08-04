import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { execFileAsync, quoteForDeviceShell } from "../../core/exec.js";

/**
 * These are the tests for a confirmed vulnerability, not a hypothetical one.
 *
 * Every device command used to be assembled into a single string and handed to
 * `/bin/sh -c` via child_process.exec. Tool parameters — URLs, bundle ids,
 * package names — were interpolated into that string raw. Verified before the
 * fix: `ios_open_url(url: 'myapp://x$(touch FILE)')` created FILE on the host
 * machine while the tool returned an ordinary-looking failure.
 *
 * That matters because these parameters are shaped by whatever the agent read
 * out of the app under test: log lines, OCR text, screen labels, deep links.
 * "The caller is trusted" is not a property this server has.
 *
 * The payloads below use a real marker file rather than asserting on the
 * command string, because the string is not the thing that was broken — the
 * shell was.
 */

const MARKER = join(tmpdir(), "execbro-injection-marker.txt");

function clearMarker() {
    try { rmSync(MARKER, { force: true }); } catch { /* nothing to clear */ }
}

// Payload shapes that reach a shell, if one is present, by different routes.
const PAYLOADS = [
    { name: "command substitution", value: `x$(touch ${MARKER})` },
    { name: "backtick substitution", value: `x\`touch ${MARKER}\`` },
    { name: "statement separator", value: `x; touch ${MARKER}` },
    { name: "background operator", value: `x & touch ${MARKER}` },
    { name: "pipe into shell", value: `x | touch ${MARKER}` },
    { name: "double-quote break-out", value: `x"; touch ${MARKER}; echo "` },
    { name: "newline separator", value: `x\ntouch ${MARKER}` },
];

describe("execFileAsync does not invoke a shell", () => {
    beforeEach(clearMarker);
    afterEach(clearMarker);

    it.each(PAYLOADS)("passes a $name payload through as literal text", async ({ value }) => {
        // `echo` is the stand-in for adb/xcrun: whatever it prints is exactly
        // the argument it received, so a shell would show up as either a
        // missing/expanded argument or a created marker file.
        const { stdout } = await execFileAsync("echo", [value]);

        expect(stdout.trimEnd()).toBe(value);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("treats the program name as a program, not a command line", async () => {
        // With a shell this would run `echo` and then `touch`; without one it
        // is a lookup for a binary with a very silly name, which must fail.
        await expect(
            execFileAsync(`echo hi; touch ${MARKER}`, [])
        ).rejects.toThrow();
        expect(existsSync(MARKER)).toBe(false);
    });

    it("keeps an argument containing spaces as a single argument", async () => {
        // The property that lets the log-show predicate and --start stamp drop
        // their hand-rolled quoting.
        const { stdout } = await execFileAsync("node", ["-e", "console.log(process.argv.length - 1)", "a b c"]);
        expect(stdout.trim()).toBe("1");
    });
});

describe("quoteForDeviceShell", () => {
    // Host-side safety is execFileAsync's job. This covers the second parse:
    // `adb shell <cmd>` hands its string to a shell ON THE DEVICE.
    it.each(PAYLOADS)("neutralises a $name payload for the device shell", async ({ value }) => {
        // sh -c stands in for the device's shell. The quoted value must come
        // back out byte-for-byte with nothing executed.
        const { stdout } = await execFileAsync("sh", ["-c", `printf %s ${quoteForDeviceShell(value)}`]);

        expect(stdout).toBe(value);
        expect(existsSync(MARKER)).toBe(false);
    });

    it("survives embedded single quotes", async () => {
        const value = `it's a 'quoted' string`;
        const { stdout } = await execFileAsync("sh", ["-c", `printf %s ${quoteForDeviceShell(value)}`]);
        expect(stdout).toBe(value);
    });

    it("wraps in single quotes rather than escaping in place", () => {
        expect(quoteForDeviceShell("plain")).toBe("'plain'");
        expect(quoteForDeviceShell("a'b")).toBe(`'a'"'"'b'`);
    });
});
