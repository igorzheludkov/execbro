import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import {
    computeProjectId,
    readConcern,
    buildWriteEnvelope,
    writeConcernAtomic,
    type StoredEnvelope,
} from "../../core/projectStore.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pstore-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SCHEMA = "execbro/project-devices";

describe("computeProjectId", () => {
    it("is stable and 16 hex chars for a real dir", () => {
        const id = computeProjectId(dir, homedir());
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(computeProjectId(dir, homedir())).toBe(id);
    });
    it("returns null for the home dir (degenerate project)", () => {
        expect(computeProjectId(homedir(), homedir())).toBeNull();
    });
    it("returns null for filesystem root", () => {
        expect(computeProjectId("/", homedir())).toBeNull();
    });
});

describe("readConcern", () => {
    it("returns empty when the file is missing", () => {
        expect(readConcern(join(dir, "devices.json"), SCHEMA, 1)).toEqual({ kind: "empty" });
    });
    it("returns empty on unparseable JSON (partial write)", () => {
        const p = join(dir, "devices.json");
        writeFileSync(p, "{ not json");
        expect(readConcern(p, SCHEMA, 1)).toEqual({ kind: "empty" });
    });
    it("returns foreign for a different schema and never touches it", () => {
        const p = join(dir, "devices.json");
        writeFileSync(p, JSON.stringify({ schema: "execbro/project-routes", version: 1, producer: "x", updatedAt: 1, edges: [] }));
        const before = readFileSync(p, "utf-8");
        expect(readConcern(p, SCHEMA, 1).kind).toBe("foreign");
        expect(readFileSync(p, "utf-8")).toBe(before);
    });
    it("returns ours and preserves a higher on-disk version", () => {
        const p = join(dir, "devices.json");
        writeFileSync(p, JSON.stringify({ schema: SCHEMA, version: 5, producer: "9.9.9", updatedAt: 1, devices: [], futureField: 42 }));
        const r = readConcern(p, SCHEMA, 1);
        expect(r.kind).toBe("ours");
        if (r.kind === "ours") {
            expect(r.env.version).toBe(5);
            expect(r.env.futureField).toBe(42);
        }
    });
});

describe("buildWriteEnvelope", () => {
    it("preserves unknown keys and never downgrades the version", () => {
        const existing: StoredEnvelope = { schema: SCHEMA, version: 5, producer: "9.9.9", updatedAt: 1, devices: [], futureField: 42 };
        const env = buildWriteEnvelope(existing, SCHEMA, 1, 1000, { devices: [{ id: "a" }] });
        expect(env.version).toBe(5);            // never downgrade
        expect(env.futureField).toBe(42);       // unknown key preserved
        expect(env.updatedAt).toBe(1000);
        expect(env.devices).toEqual([{ id: "a" }]);
    });
    it("uses currentVersion when there is no existing file", () => {
        const env = buildWriteEnvelope(null, SCHEMA, 1, 1000, { devices: [] });
        expect(env.version).toBe(1);
        expect(env.schema).toBe(SCHEMA);
    });
});

describe("writeConcernAtomic", () => {
    it("creates parent dirs and round-trips", () => {
        const p = join(dir, "nested", "devices.json");
        const env = buildWriteEnvelope(null, SCHEMA, 1, 1000, { devices: [] });
        writeConcernAtomic(p, env);
        expect(existsSync(p)).toBe(true);
        expect(JSON.parse(readFileSync(p, "utf-8")).schema).toBe(SCHEMA);
    });
});
