import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import sharp from "sharp";
import { gunzipSync } from "node:zlib";
import {
    isArtifactCaptureEnabled,
    buildArtifactBundle,
    downscaleScreenshot,
    gzipBundle,
    uploadArtifact,
    captureFailureArtifact
} from "../../core/failureArtifact.js";

describe("isArtifactCaptureEnabled", () => {
    const ORIGINAL = { ...process.env };
    beforeEach(() => {
        delete process.env.RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS;
        delete process.env.RN_DEBUGGER_TELEMETRY;
    });
    afterEach(() => {
        process.env = { ...ORIGINAL };
    });

    it("returns true by default", () => {
        expect(isArtifactCaptureEnabled()).toBe(true);
    });

    it("returns false when RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS=1", () => {
        process.env.RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS = "1";
        expect(isArtifactCaptureEnabled()).toBe(false);
    });

    it("returns false when RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS=true", () => {
        process.env.RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS = "true";
        expect(isArtifactCaptureEnabled()).toBe(false);
    });

    it("returns false when telemetry is disabled (RN_DEBUGGER_TELEMETRY=false)", () => {
        process.env.RN_DEBUGGER_TELEMETRY = "false";
        expect(isArtifactCaptureEnabled()).toBe(false);
    });
});

describe("buildArtifactBundle", () => {
    it("builds a complete bundle for a failed text-predicate tap", () => {
        const bundle = buildArtifactBundle({
            artifactId: "00000000-0000-0000-0000-000000000001",
            sessionId: "abcdef123456",
            timestamp: 1714377600000,
            version: "1.7.0",
            predicate: { text: "Sign in" },
            outcome: "failure",
            errorCategory: "validation",
            errorMessage: 'No element found matching text="Sign in"',
            strategyChain: "accessibility:no match|fiber:no pressable|ocr:not found",
            senses: {
                ocr: { ran: true, durationMs: 1820, detections: [{ text: "Login", bbox: [10, 20, 100, 50], conf: 0.93 }], closestMatch: { text: "Login", score: 0.61 } },
                fiber: { ran: true, durationMs: 0, metroConnected: true, pressables: [] },
                accessibility: { ran: true, durationMs: 240, elements: [] }
            },
            chosenTapPoint: null,
            chosenElement: null,
            deviceMeta: { platform: "ios", driver: "axe", screenSize: { w: 1170, h: 2532 }, route: "/login" }
        });

        expect(bundle.artifactId).toBe("00000000-0000-0000-0000-000000000001");
        expect(bundle.outcome).toBe("failure");
        expect(bundle.predicate).toEqual({ text: "Sign in" });
        expect(bundle.senses.ocr.closestMatch).toEqual({ text: "Login", score: 0.61 });
        expect(bundle.senses.fiber.metroConnected).toBe(true);
        expect(bundle.deviceMeta.platform).toBe("ios");
    });
});

describe("downscaleScreenshot", () => {
    it("returns a PNG buffer at 50% width", async () => {
        const input = await sharp({
            create: { width: 1170, height: 2532, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
        }).png().toBuffer();

        const out = await downscaleScreenshot(input);
        const meta = await sharp(out).metadata();
        expect(meta.format).toBe("png");
        expect(meta.width).toBe(585);
    });

    it("preserves a red-marker pixel cluster after downscaling", async () => {
        const dot = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
        const input = await sharp({
            create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } }
        }).composite([{ input: dot, left: 40, top: 40 }]).png().toBuffer();

        const out = await downscaleScreenshot(input);
        const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
        const idx = (22 * info.width + 22) * info.channels;
        expect(data[idx]).toBeGreaterThan(150);
        expect(data[idx + 1]).toBeLessThan(120);
        expect(data[idx + 2]).toBeLessThan(120);
    });
});

describe("gzipBundle", () => {
    it("gzips a JSON-serializable bundle round-trip", () => {
        const bundle = {
            artifactId: "x",
            sessionId: "s",
            timestamp: 0,
            version: "1.0.0",
            predicate: {},
            outcome: "failure" as const,
            senses: {
                ocr: { ran: false, durationMs: 0, detections: [], closestMatch: null },
                fiber: { ran: false, durationMs: 0, metroConnected: false, pressables: [] },
                accessibility: { ran: false, durationMs: 0, elements: [] }
            },
            chosenTapPoint: null,
            chosenElement: null,
            deviceMeta: { platform: "ios" as const, screenSize: { w: 1, h: 1 } }
        };
        const gz = gzipBundle(bundle);
        const json = gunzipSync(gz).toString("utf8");
        expect(JSON.parse(json)).toEqual(bundle);
    });
});

describe("uploadArtifact", () => {
    const ORIGINAL = { ...process.env };
    let lastReq: { url?: string; headers?: Record<string, string>; bodyParts?: Set<string> } = {};
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        lastReq = {};
        originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: any, init: any) => {
            const fd = init.body as FormData;
            const parts = new Set<string>();
            for (const [name] of (fd as any).entries()) parts.add(name);
            lastReq = { url: String(url), headers: init.headers, bodyParts: parts };
            return new Response(null, { status: 204 });
        }) as typeof globalThis.fetch;
        process.env.RN_AI_DEVTOOLS_ARTIFACT_ENDPOINT = "https://test.invalid";
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        process.env = { ...ORIGINAL };
    });

    it("posts multipart with bundle and PNGs and returns true", async () => {
        const ok = await uploadArtifact({
            artifactKey: "2026-04-29/00000000-0000-0000-0000-000000000001",
            apiKey: "key",
            bundleGz: Buffer.from([1, 2, 3]),
            pngs: { before: Buffer.from([4]), after: Buffer.from([5]), afterWithMarker: Buffer.from([6]) }
        });
        expect(ok).toBe(true);
        expect(lastReq.url).toBe("https://test.invalid/api/tap-artifact");
        expect((lastReq.headers as any)["X-API-Key"]).toBe("key");
        expect((lastReq.headers as any)["X-Artifact-Id"]).toBe("2026-04-29/00000000-0000-0000-0000-000000000001");
        expect(lastReq.bodyParts).toEqual(new Set(["bundle", "before.png", "after.png", "after-with-marker.png"]));
    });

    it("posts only the bundle when no PNGs available", async () => {
        const ok = await uploadArtifact({
            artifactKey: "2026-04-29/00000000-0000-0000-0000-000000000002",
            apiKey: "key",
            bundleGz: Buffer.from([1]),
            pngs: {}
        });
        expect(ok).toBe(true);
        expect(lastReq.bodyParts).toEqual(new Set(["bundle"]));
    });

    it("returns false on network error without throwing", async () => {
        globalThis.fetch = (async () => { throw new Error("network"); }) as typeof globalThis.fetch;
        const ok = await uploadArtifact({
            artifactKey: "2026-04-29/00000000-0000-0000-0000-000000000003",
            apiKey: "key",
            bundleGz: Buffer.from([1]),
            pngs: {}
        });
        expect(ok).toBe(false);
    });
});

describe("captureFailureArtifact", () => {
    const ORIGINAL = { ...process.env };
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
        process.env.RN_AI_DEVTOOLS_ARTIFACT_ENDPOINT = "https://test.invalid";
        delete process.env.RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS;
        delete process.env.RN_DEBUGGER_TELEMETRY;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        process.env = { ...ORIGINAL };
    });

    const baseInput = (overrides: Partial<Parameters<typeof captureFailureArtifact>[0]> = {}): Parameters<typeof captureFailureArtifact>[0] => ({
        apiKey: "key",
        outcome: "failure",
        predicate: { text: "Sign in" },
        sessionId: "abc",
        version: "1.7.0",
        senses: {
            ocr: { ran: true, durationMs: 1, detections: [{ text: "Login", bbox: [0, 0, 1, 1], conf: 0.9 }], closestMatch: { text: "Login", score: 0.61 } },
            fiber: { ran: true, durationMs: 0, metroConnected: true, pressables: [{ label: "Login" }, { label: "Forgot" }] },
            accessibility: { ran: true, durationMs: 1, elements: [{ label: "Login button" }] }
        },
        chosenTapPoint: null,
        chosenElement: null,
        screenshots: { before: null, after: null, afterWithMarker: null },
        deviceMeta: { platform: "ios", driver: "axe", screenSize: { w: 1170, h: 2532 } },
        ...overrides
    });

    it("returns artifactKey and structured signals when enabled", async () => {
        const out = await captureFailureArtifact(baseInput());
        expect(out.artifactKey).toMatch(/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/);
        expect(out.signals.ocrClosestMatch).toBe("Login@0.61");
        expect(out.signals.fiberPressableCount).toBe("2");
        expect(out.signals.accessibilityMatchCount).toBe("1");
        expect(out.signals.nearbyPressables).toEqual([{ label: "Login", testID: undefined }, { label: "Forgot", testID: undefined }]);
    });

    it("returns empty artifactKey but still computes signals when disabled", async () => {
        process.env.RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS = "1";
        const out = await captureFailureArtifact(baseInput());
        expect(out.artifactKey).toBe("");
        expect(out.signals.fiberPressableCount).toBe("2");
        expect(out.signals.ocrClosestMatch).toBe("Login@0.61");
    });
});

