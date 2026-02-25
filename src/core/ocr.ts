import { tmpdir } from "os";
import { join, dirname } from "path";
import { writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { spawn } from "child_process";

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
    engine: "easyocr";
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
            await new Promise<void>((resolve, reject) => {
                const proc = spawn(pythonPath, [
                    "-c", `import easyocr; easyocr.Reader(${langArg}, verbose=False)`
                ]);
                proc.on("close", (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`EasyOCR model setup exited with code ${code}. Ensure Python 3.6+ is installed.`));
                });
                proc.on("error", reject);
            });

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
 * Convert OCR coordinates to tap-ready coordinates
 * iOS: (ocrCoord * scaleFactor) / devicePixelRatio (points)
 * Android: ocrCoord * scaleFactor (pixels)
 */
function toTapCoord(
    ocrCoord: number,
    scaleFactor: number,
    platform: "ios" | "android",
    devicePixelRatio: number = 3
): number {
    const pixelCoord = ocrCoord * scaleFactor;
    return platform === "ios" ? Math.round(pixelCoord / devicePixelRatio) : Math.round(pixelCoord);
}

/**
 * Run OCR using EasyOCR
 * Requires Python 3.6+ on the system; easyocr is provided by node-easyocr's bundled venv.
 */
export async function recognizeText(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    const scaleFactor = options?.scaleFactor ?? 1;
    const platform = options?.platform ?? "ios";
    const devicePixelRatio = options?.devicePixelRatio ?? 3;
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
                        x: toTapCoord(centerX, scaleFactor, platform, devicePixelRatio),
                        y: toTapCoord(centerY, scaleFactor, platform, devicePixelRatio)
                    }
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
            lines: [], // EasyOCR returns words/phrases, not lines
            processingTimeMs: Date.now() - startTime,
            engine: "easyocr"
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
