import { describe, it, expect, afterEach } from "@jest/globals";
import { generateKeyPairSync, sign } from "crypto";
import {
    canonicalVerdictPayload,
    verifyVerdictSig,
    setVerdictPublicKeyForTests,
    type SignedVerdictFields,
} from "../../core/signedVerdict.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function fields(over: Partial<SignedVerdictFields> = {}): SignedVerdictFields {
    return {
        installationId: "inst-0001",
        monthKey: "2026-07",
        used: 100,
        limit: 600,
        canUse: true,
        capActive: true,
        resetsAt: "2026-08-01T00:00:00.000Z",
        verdictFreshUntil: "2026-07-24T12:00:00.000Z",
        ...over,
    };
}

function signFields(f: SignedVerdictFields): string {
    return sign(null, Buffer.from(canonicalVerdictPayload(f), "utf-8"), privateKey).toString("base64");
}

afterEach(() => setVerdictPublicKeyForTests(null));

describe("canonicalVerdictPayload", () => {
    it("matches the pinned cross-repo canonical literal exactly", () => {
        // PINNED: the web repo pins this exact literal in verdict-signing.test.ts.
        // Never change one side without the other.
        expect(canonicalVerdictPayload(fields())).toBe(
            '["inst-0001","2026-07",100,600,true,true,"2026-08-01T00:00:00.000Z","2026-07-24T12:00:00.000Z"]',
        );
    });
});

describe("verifyVerdictSig", () => {
    it("accepts a valid signature", () => {
        setVerdictPublicKeyForTests(PUB_PEM);
        expect(verifyVerdictSig(fields(), signFields(fields()))).toBe(true);
    });

    it("rejects when any signed field was tampered", () => {
        setVerdictPublicKeyForTests(PUB_PEM);
        const sig = signFields(fields());
        expect(verifyVerdictSig(fields({ used: 0 }), sig)).toBe(false);
        expect(verifyVerdictSig(fields({ canUse: true, capActive: false }), sig)).toBe(false);
        expect(verifyVerdictSig(fields({ verdictFreshUntil: "2099-01-01T00:00:00.000Z" }), sig)).toBe(false);
    });

    it("rejects garbage signatures without throwing", () => {
        setVerdictPublicKeyForTests(PUB_PEM);
        expect(verifyVerdictSig(fields(), "")).toBe(false);
        expect(verifyVerdictSig(fields(), "not-base64!!!")).toBe(false);
    });

    it("rejects signatures from a different key", () => {
        setVerdictPublicKeyForTests(PUB_PEM);
        const { privateKey: otherKey } = generateKeyPairSync("ed25519");
        const forged = sign(null, Buffer.from(canonicalVerdictPayload(fields()), "utf-8"), otherKey).toString("base64");
        expect(verifyVerdictSig(fields(), forged)).toBe(false);
    });
});
