import { createHash } from "crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CONFIG_DIR } from "./paths.js";

export interface StoredEnvelope {
    schema: string;
    version: number;
    producer: string;
    updatedAt: number;
    [k: string]: unknown;
}

export type ConcernRead =
    | { kind: "empty" }
    | { kind: "ours"; env: StoredEnvelope }
    | { kind: "foreign" };

/**
 * Stable 16-hex project id = sha256(realpath(cwd)).slice(0,16). Returns null for
 * a degenerate launch dir (the home dir or filesystem root), where a project
 * bucket would be meaningless — callers then behave exactly as before.
 */
export function computeProjectId(cwd: string, homeDir: string): string | null {
    let real = cwd;
    try {
        real = realpathSync(cwd);
    } catch {
        // cwd should always exist; fall back to the raw value.
    }
    if (real === homeDir || real === "/") return null;
    return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function projectsRoot(baseDir?: string): string {
    return baseDir ?? join(CONFIG_DIR, "projects");
}

/**
 * Downgrade-safe read. Only case 1 discards data:
 *  1. missing / unparseable / no envelope shape → empty (safe to (re)create)
 *  2. known schema → ours (migrated up if older; preserved as-is if newer)
 *  3. schema present but not ours → foreign (leave the file untouched)
 */
export function readConcern(
    filePath: string,
    expectedSchema: string,
    currentVersion: number,
    migrate?: (e: StoredEnvelope) => StoredEnvelope,
): ConcernRead {
    try {
        if (!existsSync(filePath)) return { kind: "empty" };
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
        if (!parsed || typeof parsed !== "object" || typeof parsed.schema !== "string") {
            return { kind: "empty" };
        }
        if (parsed.schema !== expectedSchema) return { kind: "foreign" };
        let env = parsed as StoredEnvelope;
        if (typeof env.version === "number" && env.version < currentVersion && migrate) {
            env = migrate(env);
        }
        return { kind: "ours", env };
    } catch {
        return { kind: "empty" };
    }
}

/**
 * Preserve-unknown, never-downgrade write envelope. Starts from the existing raw
 * object so unknown top-level keys survive, overlays the caller's payload, stamps
 * producer/updatedAt, and keeps the greater of (existing version, currentVersion).
 */
export function buildWriteEnvelope(
    existing: StoredEnvelope | null,
    schema: string,
    currentVersion: number,
    now: number,
    payload: Record<string, unknown>,
): StoredEnvelope {
    const base = existing ? { ...existing } : {};
    const version = Math.max(existing?.version ?? 0, currentVersion);
    return {
        ...base,
        ...payload,
        schema,
        version,
        producer: getProducerVersion(),
        updatedAt: now,
    };
}

export function writeConcernAtomic(filePath: string, env: StoredEnvelope): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env, null, 2));
    renameSync(tmp, filePath);
}

/** execbro version that wrote a file — debug + migration signal. */
export function getProducerVersion(): string {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}
