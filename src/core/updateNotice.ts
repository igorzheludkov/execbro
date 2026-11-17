/**
 * Tells the agent when this server is older than the latest npm release.
 *
 * `npx execbro` (no `@latest`) keeps reusing the copy it downloaded first, so an
 * install made that way never updates and nothing else will tell the user.
 *
 * Server instructions are built synchronously at import, before any network call
 * could finish, so the notice is driven by a cache: startup reads the latest
 * version the previous run saw, and refreshLatestVersion() updates it in the
 * background for the next start. The first run after a release is one session late.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { CONFIG_DIR } from "./paths.js";
import { isPublishedBuild } from "./buildInfo.js";
import { getServerVersion } from "./telemetry.js";

const CACHE_FILE = join(CONFIG_DIR, "latest-version.json");
// Mirrors (react-native-ai-devtools, react-native-ai-debugger) publish the same
// version numbers, so the canonical package's tag is right for all of them.
const LATEST_URL = "https://registry.npmjs.org/execbro/latest";
const FETCH_TIMEOUT_MS = 5000;

/** True when `latest` is a higher x.y.z than `current`. Prerelease suffixes are ignored. */
export function isNewer(latest: string, current: string): boolean {
    const parse = (v: string) => v.split("-")[0].split(".").map(Number);
    const a = parse(latest);
    const b = parse(current);
    if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN)) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

export function noticeFor(current: string, latest: string): string | null {
    if (!isNewer(latest, current)) return null;
    return [
        `UPDATE AVAILABLE: this ExecBro server is ${current}, the latest release is ${latest}.`,
        "npx keeps reusing the copy it downloaded first, so this install will not update by itself.",
        "Tell the user once, early: change the ExecBro command in their MCP config to `npx -y execbro@latest` and restart their client.",
    ].join("\n");
}

/** The notice for this process, from the cached latest version. Null when current, unknown, or not a published build. */
export function updateNotice(): string | null {
    if (!isPublishedBuild()) return null;
    try {
        const { version } = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
        return typeof version === "string" ? noticeFor(getServerVersion(), version) : null;
    } catch {
        return null;
    }
}

/** Fire-and-forget: saves npm's latest version for the next start. Never throws. */
export async function refreshLatestVersion(): Promise<void> {
    if (!isPublishedBuild()) return;
    try {
        const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: unknown };
        if (typeof version !== "string") return;
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify({ version, checkedAt: new Date().toISOString() }));
    } catch {
        // Offline, blocked registry, read-only home: no notice is the right outcome.
    }
}
