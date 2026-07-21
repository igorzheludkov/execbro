import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { generateKeyPairSync, sign } from "crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { canonicalVerdictPayload, setVerdictPublicKeyForTests, type SignedVerdictFields } from "../../core/signedVerdict.js";
import { readUsageCache, writeUsageCache, getUsageCacheState } from "../../core/usageCache.js";
import type { UsageInfo } from "../../core/license.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const INSTALL_ID = "11111111-2222-3333-4444-555555555555";

let dir: string;
let file: string;

function usage(over: Partial<UsageInfo> = {}): UsageInfo {
    return {
        used: 100,
        limit: 600,
        monthKey: "2026-07",
        creditsRemaining: null,
        canUse: true,
        capActive: true,
        warnThreshold: 0.8,
        resetsAt: "2026-08-01T00:00:00.000Z",
        verdictFreshUntil: "2026-07-24T12:00:00.000Z",
        ...over,
    };
}

function signedFieldsOf(u: UsageInfo, installationId: string): SignedVerdictFields {
    return {
        installationId,
        monthKey: u.monthKey,
        used: u.used,
        limit: u.limit,
        canUse: u.canUse,
        capActive: u.capActive ?? true,
        resetsAt: u.resetsAt ?? null,
        verdictFreshUntil: u.verdictFreshUntil!,
    };
}

function sigFor(u: UsageInfo, installationId: string): string {
    return sign(null, Buffer.from(canonicalVerdictPayload(signedFieldsOf(u, installationId)), "utf-8"), privateKey).toString("base64");
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-cache-"));
    file = join(dir, "usage.json");
    setVerdictPublicKeyForTests(PUB_PEM);
});

afterEach(() => {
    setVerdictPublicKeyForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

describe("usage cache v2", () => {
    it("round-trips a signed verdict", () => {
        const u = usage();
        writeUsageCache(u, sigFor(u, INSTALL_ID), INSTALL_ID, file);
        const out = readUsageCache(INSTALL_ID, file);
        expect(out).not.toBeNull();
        expect(out!.used).toBe(100);
        expect(out!.canUse).toBe(true);
        expect(out!.warnThreshold).toBe(0.8);
        expect(getUsageCacheState()).toBe("valid");
    });

    it("stores a machine-managed comment marker", () => {
        const u = usage();
        writeUsageCache(u, sigFor(u, INSTALL_ID), INSTALL_ID, file);
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        expect(raw._comment).toContain("do not edit");
        expect(raw.v).toBe(2);
    });

    it("rejects a tampered signed field as invalid_sig", () => {
        const u = usage({ used: 700, canUse: false });
        writeUsageCache(u, sigFor(u, INSTALL_ID), INSTALL_ID, file);
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        raw.signed.canUse = true;
        raw.signed.used = 0;
        writeFileSync(file, JSON.stringify(raw));
        expect(readUsageCache(INSTALL_ID, file)).toBeNull();
        expect(getUsageCacheState()).toBe("invalid_sig");
    });

    it("treats a legacy v1 flat file as missing", () => {
        writeFileSync(file, JSON.stringify(usage()));
        expect(readUsageCache(INSTALL_ID, file)).toBeNull();
        expect(getUsageCacheState()).toBe("missing");
    });

    it("treats an absent file as missing", () => {
        expect(readUsageCache(INSTALL_ID, join(dir, "nope.json"))).toBeNull();
        expect(getUsageCacheState()).toBe("missing");
    });

    it("rejects a cache signed for a different installation", () => {
        const u = usage();
        writeUsageCache(u, sigFor(u, "other-install"), "other-install", file);
        expect(readUsageCache(INSTALL_ID, file)).toBeNull();
        expect(getUsageCacheState()).toBe("missing");
    });

    it("tampering unsigned extras does not invalidate the verdict", () => {
        const u = usage();
        writeUsageCache(u, sigFor(u, INSTALL_ID), INSTALL_ID, file);
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        raw.unsigned.warnThreshold = 0.99;
        writeFileSync(file, JSON.stringify(raw));
        const out = readUsageCache(INSTALL_ID, file);
        expect(out).not.toBeNull();
        expect(out!.used).toBe(100);
    });

    it("self-verify guard: skips the write entirely when the provided sig doesn't match the derived signed block", () => {
        const u = usage();
        // Sign for a different set of field values than the ones actually
        // passed to writeUsageCache — the re-derived `signed` block for `u`
        // will not verify against this sig, so the write must be skipped.
        const mismatchedSig = sigFor(usage({ used: 999, canUse: false }), INSTALL_ID);
        writeUsageCache(u, mismatchedSig, INSTALL_ID, file);
        expect(existsSync(file)).toBe(false);
        expect(readUsageCache(INSTALL_ID, file)).toBeNull();
        expect(getUsageCacheState()).toBe("missing");
    });
});
