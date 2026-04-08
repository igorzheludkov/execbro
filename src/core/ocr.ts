import { tmpdir } from "os";
import { join, dirname } from "path";
import { writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { spawn } from "child_process";
import { getInstallationId } from "./telemetry.js";

// ============================================================================
// Cloud OCR Configuration
// ============================================================================

const OCR_ENDPOINT = "https://rn-debugger-ocr.500griven.workers.dev";
const OCR_API_KEY = "4adf74c1f1afa5c4dc5eddcfc17787aea3b21b4a518bad27df152515d71f3d54";
const OCR_TIMEOUT_MS = 5_000;

export interface OCRWord {
    text: string;
    confidence: number;
    bbox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    center: {
        x: number;
        y: number;
    };
    /** Tap-ready coordinates (adjusted for scale and device pixel ratio) */
    tapCenter: {
        x: number;
        y: number;
    };
}

export interface OCROptions {
    /** Scale factor from image resizing (default: 1) */
    scaleFactor?: number;
    /** Platform for coordinate conversion: ios uses points, android uses raw pixels */
    platform?: "ios" | "android";
    /** Device pixel ratio for iOS coordinate conversion (default: 3 for @3x devices, use 2 for older/iPad) */
    devicePixelRatio?: number;
}

export interface OCRLine {
    text: string;
    confidence: number;
    bbox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    center: {
        x: number;
        y: number;
    };
    /** Tap-ready coordinates (adjusted for scale and device pixel ratio) */
    tapCenter: {
        x: number;
        y: number;
    };
}

export interface OCRResult {
    success: boolean;
    fullText: string;
    confidence: number;
    words: OCRWord[];
    lines: OCRLine[];
    processingTimeMs: number;
    engine: "easyocr" | "cloud";
}

// EasyOCR types
interface EasyOCRResult {
    text: string;
    confidence: number;
    bbox: number[][];  // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
}

// EasyOCR instance
let easyOCRInstance: import("node-easyocr").EasyOCR | null = null;
let easyOCRInitPromise: Promise<import("node-easyocr").EasyOCR> | null = null;

/**
 * Promise with timeout helper
 */
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(errorMsg)), ms)
        )
    ]);
}

/**
 * Get configured OCR languages from environment variable
 * English is always included as fallback
 * Default: "en" (English only)
 * Example: EASYOCR_LANGUAGES="es,fr" for Spanish, French (+ English)
 */
function getOCRLanguages(): string[] {
    const envLangs = process.env.EASYOCR_LANGUAGES;
    const languages = envLangs
        ? envLangs.split(",").map(lang => lang.trim()).filter(Boolean)
        : [];

    // Always include English as fallback
    if (!languages.includes("en")) {
        languages.push("en");
    }

    return languages;
}

/**
 * Initialize EasyOCR (Python-based, better for colored backgrounds)
 * Requires Python 3.6+ on the system; easyocr is provided by node-easyocr's bundled venv.
 */
async function getEasyOCR(): Promise<import("node-easyocr").EasyOCR> {
    if (easyOCRInstance) {
        return easyOCRInstance;
    }

    if (easyOCRInitPromise) {
        return easyOCRInitPromise;
    }

    easyOCRInitPromise = (async () => {
        try {
            const languages = getOCRLanguages();
            const { EasyOCR } = await import("node-easyocr");
            const ocr = new EasyOCR();

            // node-easyocr's preinstall creates a venv with easyocr, but the
            // runtime hardcodes pythonPath to system 'python3' which won't have it.
            // Resolve the package location and point at its bundled venv instead.
            const require = createRequire(import.meta.url);
            const easyocrPkgDir = dirname(require.resolve("node-easyocr"));
            // Matches the convention in node-easyocr's own setup-python-env.js
            const venvBin = process.platform === "win32" ? "Scripts" : "bin";
            const venvExe = process.platform === "win32" ? "python.exe" : "python";
            const venvPython = join(easyocrPkgDir, "..", "venv", venvBin, venvExe);
            if (existsSync(venvPython)) {
                (ocr as any).pythonPath = venvPython;
            }

            // node-easyocr's JSON parser chokes on easyocr's progress bar output
            // during model downloads. Pre-download models with verbose=False so
            // node-easyocr's init never sees non-JSON output on stdout.
            // Always run with the configured languages since each language has its
            // own recognition model that may need downloading.
            const pythonPath = (ocr as any).pythonPath || "python3";
            const langArg = JSON.stringify(languages);
            await withTimeout(new Promise<void>((resolve, reject) => {
                const proc = spawn(pythonPath, [
                    "-c", `import easyocr; easyocr.Reader(${langArg}, verbose=False)`
                ]);
                let stderr = "";
                proc.stderr.on("data", (d: Buffer) => { stderr += d; });
                proc.on("close", (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`EasyOCR model setup failed (code ${code}): ${stderr.trim() || "unknown error"}. Ensure Python 3.6+ is installed.`));
                });
                proc.on("error", reject);
            }), 120000, "EasyOCR model download timeout -- check your network connection");

            await withTimeout(ocr.init(languages), 30000, "EasyOCR init timeout. Ensure Python 3.6+ is available on your system.");
            easyOCRInstance = ocr;
            return ocr;
        } catch (error) {
            easyOCRInitPromise = null;
            throw error;
        }
    })();

    return easyOCRInitPromise;
}

/**
 * Infer iOS device pixel ratio from screenshot dimensions
 * @3x devices: Most modern iPhones (width >= 1080)
 * @2x devices: Older iPhones, iPads (width 640-1080 or width >= 1500 for iPads)
 * @1x devices: Very old (rare)
 */
export function inferIOSDevicePixelRatio(width: number, height: number): number {
    // Ensure we're looking at the shorter dimension for width
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);

    // iPads are typically @2x regardless of size
    // iPad resolutions have aspect ratios closer to 4:3 (e.g., 2048x2732)
    const aspectRatio = longSide / shortSide;
    if (aspectRatio < 1.5) {
        // Likely an iPad (4:3 ish aspect ratio)
        return 2;
    }

    // iPhones: Check short side dimension
    // @3x phones have short side >= 1080 (e.g., 1170, 1179, 1284, 1290)
    // @2x phones have short side < 1080 (e.g., 640, 750)
    if (shortSide >= 1080) {
        return 3;
    }

    // Older @2x iPhones (iPhone 8, SE, etc.)
    return 2;
}

/**
 * Convert OCR bounding box coordinate to screenshot-image-pixel space.
 * OCR runs on the downscaled image, so coordinates are already in image-pixel space.
 * We return them as-is — tap() handles un-downscaling and platform conversion.
 */
export function toTapCoord(ocrCoord: number, _scaleFactor: number): number {
    return Math.round(ocrCoord);
}

// ============================================================================
// Cloud OCR Response Types
// ============================================================================

interface CloudOCRWord {
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface CloudOCRResponse {
    success: boolean;
    fullText: string;
    confidence: number;
    words: CloudOCRWord[];
    processingTimeMs: number;
}

/**
 * Run OCR via Cloudflare Worker → Google Cloud Vision.
 * Returns null on failure (caller should fall back to local EasyOCR).
 */
async function recognizeTextCloud(
    imageBuffer: Buffer,
    options?: OCROptions
): Promise<OCRResult | null> {
    const scaleFactor = options?.scaleFactor ?? 1;
    const startTime = Date.now();

    const body = new Uint8Array(imageBuffer);
    const fetchOptions = {
        method: "POST",
        headers: {
            "X-API-Key": OCR_API_KEY,
            "X-Installation-Id": getInstallationId(),
            "Content-Type": "image/png",
        },
        body,
    };

    let response: Response;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

        response = await fetch(`${OCR_ENDPOINT}/ocr`, {
            ...fetchOptions,
            signal: controller.signal,
        });

        clearTimeout(timeout);
    } catch {
        return null; // Network error or timeout — fall back to local
    }

    // On 502, retry once after 500ms
    if (response.status === 502) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

            response = await fetch(`${OCR_ENDPOINT}/ocr`, {
                ...fetchOptions,
                signal: controller.signal,
            });

            clearTimeout(timeout);
        } catch {
            return null;
        }
    }

    // Any non-200 → fall back to local
    if (!response.ok) {
        return null;
    }

    let data: CloudOCRResponse;
    try {
        data = (await response.json()) as CloudOCRResponse;
    } catch {
        return null;
    }

    if (!data.success) {
        return null;
    }

    // Map cloud response to OCRResult, computing center and tapCenter client-side
    const words: OCRWord[] = data.words.map((w) => {
        const centerX = Math.round((w.bbox.x0 + w.bbox.x1) / 2);
        const centerY = Math.round((w.bbox.y0 + w.bbox.y1) / 2);

        return {
            text: w.text,
            confidence: w.confidence,
            bbox: w.bbox,
            center: { x: centerX, y: centerY },
            tapCenter: {
                x: toTapCoord(centerX, scaleFactor),
                y: toTapCoord(centerY, scaleFactor),
            },
        };
    });

    return {
        success: true,
        fullText: data.fullText,
        confidence: data.confidence,
        words,
        lines: [],
        processingTimeMs: Date.now() - startTime,
        engine: "cloud",
    };
}

/**
 * Run OCR — tries cloud (Google Vision) first, falls back to local EasyOCR.
 */
export async function recognizeText(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    // Try cloud OCR first
    const cloudResult = await recognizeTextCloud(imageBuffer, options);
    if (cloudResult) {
        return cloudResult;
    }

    // Fall back to local EasyOCR
    return recognizeTextLocal(imageBuffer, options);
}

/**
 * Run OCR using local EasyOCR (fallback).
 * Requires Python 3.6+ on the system; easyocr is provided by node-easyocr's bundled venv.
 */
async function recognizeTextLocal(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    const scaleFactor = options?.scaleFactor ?? 1;
    const startTime = Date.now();

    let ocr: import("node-easyocr").EasyOCR;
    try {
        ocr = await getEasyOCR();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`EasyOCR initialization failed. Ensure Python 3.6+ is available on your system. Error: ${message}`);
    }

    // Write buffer to temp file (EasyOCR requires file path)
    const tempPath = join(tmpdir(), `ocr-${randomUUID()}.png`);

    try {
        await writeFile(tempPath, imageBuffer);

        const results = await withTimeout(
            ocr.readText(tempPath),
            15000,
            "EasyOCR readText timeout"
        ) as EasyOCRResult[];

        const words: OCRWord[] = [];
        const textParts: string[] = [];
        let totalConfidence = 0;

        for (const result of results) {
            if (result.text && result.bbox) {
                // EasyOCR bbox is [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] (4 corners)
                const x0 = Math.min(result.bbox[0][0], result.bbox[3][0]);
                const y0 = Math.min(result.bbox[0][1], result.bbox[1][1]);
                const x1 = Math.max(result.bbox[1][0], result.bbox[2][0]);
                const y1 = Math.max(result.bbox[2][1], result.bbox[3][1]);

                const centerX = Math.round((x0 + x1) / 2);
                const centerY = Math.round((y0 + y1) / 2);

                words.push({
                    text: result.text.trim(),
                    confidence: result.confidence * 100,
                    bbox: { x0, y0, x1, y1 },
                    center: { x: centerX, y: centerY },
                    tapCenter: {
                        x: toTapCoord(centerX, scaleFactor),
                        y: toTapCoord(centerY, scaleFactor),
                    },
                });

                textParts.push(result.text.trim());
                totalConfidence += result.confidence;
            }
        }

        return {
            success: true,
            fullText: textParts.join(" "),
            confidence: results.length > 0 ? (totalConfidence / results.length) * 100 : 0,
            words,
            lines: [],
            processingTimeMs: Date.now() - startTime,
            engine: "easyocr",
        };
    } finally {
        // Clean up temp file
        try {
            await unlink(tempPath);
        } catch {
            // Ignore cleanup errors
        }
    }
}

export async function terminateOCRWorker(): Promise<void> {
    if (easyOCRInstance) {
        try {
            await easyOCRInstance.close();
        } catch {
            // Ignore close errors
        }
        easyOCRInstance = null;
        easyOCRInitPromise = null;
    }
}
