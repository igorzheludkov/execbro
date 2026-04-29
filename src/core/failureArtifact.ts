import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { getTelemetryApiKey, getTelemetryEndpoint } from "./telemetry.js";

const TRUTHY_DISABLE = new Set(["1", "true", "yes", "on"]);
const FALSY_TELEMETRY = new Set(["0", "false", "no", "off"]);
const UPLOAD_TIMEOUT_MS = 5000;

export function isArtifactCaptureEnabled(): boolean {
    const explicitDisable = process.env.RN_AI_DEVTOOLS_DISABLE_FAILURE_ARTIFACTS;
    if (explicitDisable && TRUTHY_DISABLE.has(explicitDisable.toLowerCase())) return false;

    const telemetryFlag = process.env.RN_DEBUGGER_TELEMETRY;
    if (telemetryFlag && FALSY_TELEMETRY.has(telemetryFlag.toLowerCase())) return false;

    return true;
}

export type ArtifactOutcome = "failure" | "unmeaningful";

export interface OcrDetection {
    text: string;
    bbox: [number, number, number, number];
    conf: number;
}

export interface ArtifactSenses {
    ocr: {
        ran: boolean;
        durationMs: number;
        detections: OcrDetection[];
        closestMatch: { text: string; score: number } | null;
    };
    fiber: {
        ran: boolean;
        durationMs: number;
        metroConnected: boolean;
        pressables: Array<{ label?: string; testID?: string; bounds?: number[]; componentName?: string }>;
    };
    accessibility: {
        ran: boolean;
        durationMs: number;
        elements: Array<{ label?: string; testID?: string; frame?: number[] }>;
    };
}

export interface ArtifactInput {
    artifactId: string;
    sessionId: string;
    timestamp: number;
    version: string;
    predicate: Record<string, unknown>;
    outcome: ArtifactOutcome;
    errorCategory?: string;
    errorMessage?: string;
    strategyChain?: string;
    changeRate?: number;
    meaningful?: boolean;
    senses: ArtifactSenses;
    chosenTapPoint: { x: number; y: number } | null;
    chosenElement: Record<string, unknown> | null;
    deviceMeta: {
        platform: "ios" | "android";
        driver?: string;
        screenSize: { w: number; h: number };
        route?: string;
    };
}

export type ArtifactBundle = ArtifactInput;

export function buildArtifactBundle(input: ArtifactInput): ArtifactBundle {
    return { ...input };
}

export async function downscaleScreenshot(input: Buffer): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height) {
        return await sharp(input).png().toBuffer();
    }
    return await sharp(input)
        .resize({ width: Math.max(1, Math.round(meta.width / 2)) })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

export function gzipBundle(bundle: ArtifactBundle): Buffer {
    return gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"));
}

export interface UploadInput {
    artifactKey: string;
    apiKey: string;
    bundleGz: Buffer;
    pngs: { before?: Buffer; after?: Buffer; afterWithMarker?: Buffer };
}

export async function uploadArtifact(input: UploadInput): Promise<boolean> {
    const endpoint = process.env.RN_AI_DEVTOOLS_ARTIFACT_ENDPOINT || getTelemetryEndpoint();
    const url = `${endpoint}/api/tap-artifact`;

    const fd = new FormData();
    fd.append("bundle", new Blob([new Uint8Array(input.bundleGz)], { type: "application/gzip" }), "bundle");
    if (input.pngs.before) fd.append("before.png", new Blob([new Uint8Array(input.pngs.before)], { type: "image/png" }), "before.png");
    if (input.pngs.after) fd.append("after.png", new Blob([new Uint8Array(input.pngs.after)], { type: "image/png" }), "after.png");
    if (input.pngs.afterWithMarker) fd.append("after-with-marker.png", new Blob([new Uint8Array(input.pngs.afterWithMarker)], { type: "image/png" }), "after-with-marker.png");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "X-API-Key": input.apiKey,
                "X-Artifact-Id": input.artifactKey
            },
            body: fd,
            signal: ctrl.signal
        });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export interface CaptureInput {
    apiKey?: string;
    outcome: ArtifactOutcome;
    predicate: Record<string, unknown>;
    errorMessage?: string;
    errorCategory?: string;
    strategyChain?: string;
    sessionId: string;
    version: string;
    changeRate?: number;
    meaningful?: boolean;
    senses: ArtifactSenses;
    chosenTapPoint: { x: number; y: number } | null;
    chosenElement: Record<string, unknown> | null;
    screenshots: {
        before: Buffer | null;
        after: Buffer | null;
        afterWithMarker: Buffer | null;
    };
    deviceMeta: ArtifactInput["deviceMeta"];
}

export interface CaptureSignals {
    artifactKey: string;
    ocrClosestMatch: string;
    fiberPressableCount: string;
    accessibilityMatchCount: string;
    appRoute: string;
    nearbyPressables: Array<{ label?: string; testID?: string }>;
}

export interface CaptureResult {
    artifactKey: string;
    signals: CaptureSignals;
}

export async function captureFailureArtifact(input: CaptureInput): Promise<CaptureResult> {
    const signals: CaptureSignals = {
        artifactKey: "",
        ocrClosestMatch: input.senses.ocr.closestMatch
            ? `${input.senses.ocr.closestMatch.text}@${input.senses.ocr.closestMatch.score.toFixed(2)}`
            : "",
        fiberPressableCount: input.senses.fiber.ran ? String(input.senses.fiber.pressables.length) : "",
        accessibilityMatchCount: input.senses.accessibility.ran ? String(input.senses.accessibility.elements.length) : "",
        appRoute: input.deviceMeta.route || "",
        nearbyPressables: input.senses.fiber.pressables.slice(0, 3).map(p => ({ label: p.label, testID: p.testID }))
    };

    if (!isArtifactCaptureEnabled()) {
        return { artifactKey: "", signals };
    }

    const date = new Date().toISOString().slice(0, 10);
    const artifactId = randomUUID();
    const artifactKey = `${date}/${artifactId}`;
    signals.artifactKey = artifactKey;

    let bundleGz: Buffer;
    const pngs: UploadInput["pngs"] = {};
    try {
        const bundle = buildArtifactBundle({
            artifactId,
            sessionId: input.sessionId,
            timestamp: Date.now(),
            version: input.version,
            predicate: input.predicate,
            outcome: input.outcome,
            errorCategory: input.errorCategory,
            errorMessage: input.errorMessage,
            strategyChain: input.strategyChain,
            changeRate: input.changeRate,
            meaningful: input.meaningful,
            senses: input.senses,
            chosenTapPoint: input.chosenTapPoint,
            chosenElement: input.chosenElement,
            deviceMeta: input.deviceMeta
        });
        bundleGz = gzipBundle(bundle);

        if (input.screenshots.before) pngs.before = await downscaleScreenshot(input.screenshots.before);
        if (input.screenshots.after) pngs.after = await downscaleScreenshot(input.screenshots.after);
        if (input.screenshots.afterWithMarker) pngs.afterWithMarker = await downscaleScreenshot(input.screenshots.afterWithMarker);
    } catch {
        return { artifactKey: "", signals: { ...signals, artifactKey: "" } };
    }

    void uploadArtifact({ artifactKey, apiKey: input.apiKey ?? getTelemetryApiKey(), bundleGz, pngs });

    return { artifactKey, signals };
}
