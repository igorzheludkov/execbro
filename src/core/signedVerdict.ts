import { createPublicKey, verify } from "crypto";

// SPKI PEM public key for usage-verdict signatures. The matching private key
// lives only in the web backend (LICENSE_SIGNING_KEY env). Generated once via
// web/scripts/generate-license-signing-key.mjs.
const LICENSE_VERDICT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2IaqERB2ey5GlaKou7DaR5lygDKpJzW53TZjPHVGBhQ=
-----END PUBLIC KEY-----`;

let publicKeyOverride: string | null = null;

export function setVerdictPublicKeyForTests(pem: string | null): void {
    publicKeyOverride = pem;
}

export interface SignedVerdictFields {
    installationId: string;
    monthKey: string;
    used: number;
    limit: number | null;
    canUse: boolean;
    capActive: boolean;
    resetsAt: string | null;
    verdictFreshUntil: string;
}

// Byte-identical twin of web/src/lib/verdict-signing.ts:canonicalVerdictPayload.
// Array form: field order fixed by position, immune to key-order differences.
// Both repos pin the same canonical literal in tests.
export function canonicalVerdictPayload(v: SignedVerdictFields): string {
    return JSON.stringify([
        v.installationId,
        v.monthKey,
        v.used,
        v.limit,
        v.canUse,
        v.capActive,
        v.resetsAt,
        v.verdictFreshUntil,
    ]);
}

export function verifyVerdictSig(signed: SignedVerdictFields, sigB64: string): boolean {
    try {
        const key = createPublicKey(publicKeyOverride ?? LICENSE_VERDICT_PUBLIC_KEY_PEM);
        return verify(
            null,
            Buffer.from(canonicalVerdictPayload(signed), "utf-8"),
            key,
            Buffer.from(sigB64, "base64"),
        );
    } catch {
        return false;
    }
}
