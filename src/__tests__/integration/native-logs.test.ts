// Device-gated: skips cleanly when no emulator/simulator is attached, matching
// the pattern in connection-health.test.ts. CI has no device, and a real
// tombstone cannot be provoked there — the parsing and filtering logic is
// covered by the unit fixtures instead.

import { describe, it, expect, beforeAll } from "@jest/globals";
import { execSync } from "node:child_process";
import { fetchAndroidLines, buildLogcatArgs } from "../../core/logSourceAndroid.js";

function hasAndroidDevice(): boolean {
    try {
        const out = execSync("adb devices", { encoding: "utf8", timeout: 5000 });
        return out.split("\n").slice(1).some((l) => l.trim().endsWith("device"));
    } catch {
        return false;
    }
}

const maybe = hasAndroidDevice() ? describe : describe.skip;

maybe("android native log acquisition (live device)", () => {
    it("fetches and parses real logcat output", async () => {
        const lines = await fetchAndroidLines({ sinceTs: new Date(Date.now() - 60_000) });
        expect(Array.isArray(lines)).toBe(true);
        for (const line of lines.slice(0, 20)) {
            expect(line.ts.getTime()).toBeGreaterThan(0);
            expect(typeof line.tag).toBe("string");
            expect(typeof line.message).toBe("string");
        }
    }, 30_000);

    it("does not blow the exec buffer on an unwindowed read", async () => {
        // A full dump is ~13.8MB against node's 1MiB default.
        const lines = await fetchAndroidLines({});
        expect(lines.length).toBeGreaterThan(0);
    }, 30_000);

    it("builds a command that adb accepts", () => {
        const cmd = buildLogcatArgs({ sinceTs: new Date(Date.now() - 10_000) });
        const out = execSync(`${cmd} | head -5`, { encoding: "utf8", timeout: 10_000 });
        expect(typeof out).toBe("string");
    });
});
