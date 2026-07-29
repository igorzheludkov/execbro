import type { AppIdentity, RawLogLine } from "./logEvents.js";

export type OwnReason = "declared" | "pid" | "verdict";
export type OwnershipVerdict = { owned: true; reason: OwnReason } | { owned: false };

/**
 * Tags whose lines are VERDICTS ABOUT an app rather than output FROM it.
 *
 * This allowlist is a hard gate, not a hint. Two measured traps make a bare
 * "message contains the package name" rule wrong:
 *   - MMKV / nativeloader embed the package as a filesystem path
 *   - ActivityThread announces package changes from OTHER apps' pids
 * Neither tag is listed, so the name check never runs for them.
 */
export const ANDROID_VERDICT_TAGS: ReadonlySet<string> = new Set([
    "ActivityManager",
    "ActivityTaskManager",
    "AndroidRuntime",
    "DEBUG",
    "lowmemorykiller",
    "PackageManager",
    "InputDispatcher",
]);

/** iOS equivalents: process termination and launch failure reporters. */
export const IOS_VERDICT_SUBSYSTEMS: ReadonlySet<string> = new Set([
    "com.apple.runningboard",
    "com.apple.FrontBoard",
]);

/**
 * Tags whose output is already carried by another source.
 *
 * React Native mirrors console.* into logcat under `ReactNativeJS`. Those lines
 * are in the CDP console buffer too, so owning them here would double-report
 * under source:"all" and bury crashes under ordinary app logging in
 * source:"native". Keeping the two sources disjoint is what makes merging safe.
 */
const MIRRORED_TAGS: ReadonlySet<string> = new Set(["ReactNativeJS"]);

function isVerdictSource(line: RawLogLine, platform: AppIdentity["platform"]): boolean {
    if (platform === "android") return ANDROID_VERDICT_TAGS.has(line.tag);
    // iOS tags are "subsystem:category" — match on the subsystem half.
    const subsystem = line.tag.split(":")[0];
    return IOS_VERDICT_SUBSYSTEMS.has(subsystem);
}

/**
 * Does the message name this package as a whole identifier?
 *
 * A bare `includes` would attribute `ANR in com.acme.app.dev` to
 * `com.acme.app`. Debug and release variants differing only by a Gradle
 * applicationIdSuffix are routinely installed side by side, so the shorter
 * id being a prefix of the longer one is the normal case, not an edge case.
 */
function namesPackage(message: string, appId: string): boolean {
    const boundary = /[A-Za-z0-9_.]/;
    let from = 0;
    for (;;) {
        const at = message.indexOf(appId, from);
        if (at === -1) return false;
        const before = at === 0 ? "" : message[at - 1];
        const after = message[at + appId.length] ?? "";
        if (!boundary.test(before) && !boundary.test(after)) return true;
        from = at + 1;
    }
}

/**
 * Decide whether a line belongs to the app under test. First match wins.
 *
 * Rule order matters: `declared` precedes `pid` because a tombstone is written
 * by tombstoned's pid while naming the dead app as its subject, so pid
 * matching would miss every crash — the exact case this feature exists for.
 */
export function isOwned(line: RawLogLine, identity: AppIdentity): OwnershipVerdict {
    if (MIRRORED_TAGS.has(line.tag)) return { owned: false };
    if (line.subject && line.subject === identity.appId) {
        return { owned: true, reason: "declared" };
    }
    if (identity.pid !== undefined && line.pid === identity.pid) {
        return { owned: true, reason: "pid" };
    }
    if (isVerdictSource(line, identity.platform) && namesPackage(line.message, identity.appId)) {
        return { owned: true, reason: "verdict" };
    }
    return { owned: false };
}
