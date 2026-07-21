import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR } from "./paths.js";
import { verifyVerdictSig, type SignedVerdictFields } from "./signedVerdict.js";
import type { UsageInfo } from "./license.js";

const USAGE_FILE = join(CONFIG_DIR, "usage.json");

export type UsageCacheState = "valid" | "invalid_sig" | "missing";

// v2 cache: the `signed` block plus `sig` come from the server verbatim and
// are never client-mutated; `unsigned` holds display-only extras (warn
// threshold, promo flags). Local usage increments are in-memory only — the
// file on disk is 100% server-attested content.
interface UsageCacheFileV2 {
    v: 2;
    _comment: string;
    signed: SignedVerdictFields;
    sig: string;
    unsigned: Record<string, unknown>;
}

const FILE_COMMENT = "machine-managed by execbro — do not edit; contents are cryptographically signed";

let state: UsageCacheState = "missing";

export function getUsageCacheState(): UsageCacheState {
    return state;
}

export function readUsageCache(expectedInstallationId: string, filePath: string = USAGE_FILE): UsageInfo | null {
    try {
        if (!existsSync(filePath)) {
            state = "missing";
            return null;
        }
        const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<UsageCacheFileV2>;
        if (raw?.v !== 2 || typeof raw.sig !== "string" || !raw.signed) {
            // Legacy v1 or unknown shape — treated as absent (self-heals to v2
            // on the next successful validate).
            state = "missing";
            return null;
        }
        if (raw.signed.installationId !== expectedInstallationId) {
            state = "missing";
            return null;
        }
        if (!verifyVerdictSig(raw.signed, raw.sig)) {
            state = "invalid_sig";
            return null;
        }
        state = "valid";
        const { installationId: _ignored, ...verdictFields } = raw.signed;
        return { ...(raw.unsigned ?? {}), ...verdictFields } as UsageInfo;
    } catch {
        state = "missing";
        return null;
    }
}

export function writeUsageCache(
    usage: UsageInfo,
    verdictSig: string,
    installationId: string,
    filePath: string = USAGE_FILE,
): void {
    try {
        const signed: SignedVerdictFields = {
            installationId,
            monthKey: usage.monthKey,
            used: usage.used,
            limit: usage.limit,
            canUse: usage.canUse,
            capActive: usage.capActive ?? true,
            resetsAt: usage.resetsAt ?? null,
            verdictFreshUntil: usage.verdictFreshUntil ?? "",
        };
        // Self-verify before persisting: writeUsageCache re-derives `signed` from
        // the client-side usage object with `?? true` / `?? null` normalization
        // that must match the server's own normalization byte-for-byte, or the
        // signature won't verify on the next read. If the server ever emits a
        // value that normalizes differently here than it did there (e.g. an
        // undefined capActive), don't persist a cache that will fail its own
        // round-trip — that would poison the cache into permanent invalid_sig
        // and silently disable offline enforcement. Skipping the write instead
        // fails open-and-loud: the next read just reports "missing".
        if (!verifyVerdictSig(signed, verdictSig)) {
            return;
        }
        const {
            monthKey: _mk, used: _u, limit: _l, canUse: _c, capActive: _ca,
            resetsAt: _r, verdictFreshUntil: _v,
            ...unsigned
        } = usage;
        const file: UsageCacheFileV2 = { v: 2, _comment: FILE_COMMENT, signed, sig: verdictSig, unsigned };
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, JSON.stringify(file, null, 2));
    } catch {
        // Best-effort — cache write must never affect tool flow.
    }
}
