import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import {
    recordDevice,
    recordScreenMetrics,
    listDevices,
    mergeDeviceLists,
    type DeviceMemoryEntry,
} from "../../core/projectMemory.js";

let projectDir: string;   // stands in as the "cwd" (a real dir, not home/root)
let baseDir: string;      // stands in as ~/.execbro/projects

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pm-cwd-"));
    baseDir = mkdtempSync(join(tmpdir(), "pm-base-"));
});
afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
});

function entry(over: Partial<DeviceMemoryEntry>): DeviceMemoryEntry {
    return { identifier: "ID", name: "Dev", platform: "ios", firstSeenAt: 1, lastUsedAt: 1, useCount: 1, ...over };
}

describe("mergeDeviceLists", () => {
    it("unions by identifier, keeps the newer lastUsedAt entry, caps and sorts", () => {
        const a = [entry({ identifier: "x", lastUsedAt: 10, useCount: 1, firstSeenAt: 5 })];
        const b = [
            entry({ identifier: "x", lastUsedAt: 20, useCount: 3, firstSeenAt: 8, name: "Newer" }),
            entry({ identifier: "y", lastUsedAt: 15 }),
        ];
        const merged = mergeDeviceLists(a, b);
        expect(merged.map((e) => e.identifier)).toEqual(["x", "y"]);   // sorted desc by lastUsedAt
        const x = merged.find((e) => e.identifier === "x")!;
        expect(x.name).toBe("Newer");        // newer entry wins wholesale
        expect(x.firstSeenAt).toBe(5);        // earliest firstSeenAt retained
        expect(x.useCount).toBe(3);           // max useCount
    });
    it("caps the list at 20", () => {
        const many = Array.from({ length: 25 }, (_, i) => entry({ identifier: `d${i}`, lastUsedAt: i }));
        expect(mergeDeviceLists([], many).length).toBe(20);
    });
});

describe("recordDevice + listDevices", () => {
    it("writes devices.json + meta.json and lists the device", () => {
        recordDevice({ identifier: "UDID-1", name: "iPhone Air", platform: "ios", appId: "com.x" },
            { cwd: projectDir, baseDir, now: 1000 });
        const list = listDevices({ cwd: projectDir, baseDir });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ identifier: "UDID-1", name: "iPhone Air", useCount: 1, lastUsedAt: 1000 });
        // meta.json exists with the real path
        const files = readdirSync(baseDir);
        const metaPath = join(baseDir, files[0], "meta.json");
        expect(existsSync(metaPath)).toBe(true);
        expect(JSON.parse(readFileSync(metaPath, "utf-8")).path).toContain("pm-cwd-");
    });
    it("bumps useCount and lastUsedAt on repeat, preserving firstSeenAt", () => {
        recordDevice({ identifier: "UDID-1", name: "iPhone", platform: "ios" }, { cwd: projectDir, baseDir, now: 1000 });
        recordDevice({ identifier: "UDID-1", name: "iPhone", platform: "ios" }, { cwd: projectDir, baseDir, now: 2000 });
        const list = listDevices({ cwd: projectDir, baseDir });
        expect(list[0]).toMatchObject({ useCount: 2, firstSeenAt: 1000, lastUsedAt: 2000 });
    });
    it("returns [] and writes nothing for a degenerate cwd (home dir)", () => {
        recordDevice({ identifier: "X", name: "n", platform: "ios" },
            { cwd: homedir(), baseDir, now: 1 });
        expect(readdirSync(baseDir)).toHaveLength(0);
    });
});

describe("recordScreenMetrics", () => {
    it("patches an existing entry's screenMetrics", () => {
        recordDevice({ identifier: "UDID-1", name: "iPhone", platform: "ios" }, { cwd: projectDir, baseDir, now: 1000 });
        recordScreenMetrics("UDID-1", {
            rawWidth: 1260, rawHeight: 2736, deliveredWidth: 921, deliveredHeight: 2000,
            downscale: 0.731, scale: 3, capturedAt: 1500,
        }, { cwd: projectDir, baseDir, now: 1500 });
        const list = listDevices({ cwd: projectDir, baseDir });
        expect(list[0].screenMetrics?.deliveredWidth).toBe(921);
    });
    it("no-ops when the identifier is unknown", () => {
        recordScreenMetrics("NOPE", {
            rawWidth: 1, rawHeight: 1, deliveredWidth: 1, deliveredHeight: 1, downscale: 1, capturedAt: 1,
        }, { cwd: projectDir, baseDir, now: 1 });
        expect(listDevices({ cwd: projectDir, baseDir })).toHaveLength(0);
    });
});
