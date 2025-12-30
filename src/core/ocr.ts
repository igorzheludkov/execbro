import { createWorker, Worker } from "tesseract.js";
import sharp from "sharp";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";

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
    /** OCR engine to use: auto (default), easyocr, or tesseract */
    engine?: "auto" | "easyocr" | "tesseract";
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
    engine?: "easyocr" | "tesseract";
}

// EasyOCR types
interface EasyOCRResult {
    text: string;
    confidence: number;
    bbox: number[][];  // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
}

// Cached Tesseract worker for fallback
let cachedTesseractWorker: Worker | null = null;
let tesseractWorkerPromise: Promise<Worker> | null = null;

// EasyOCR instance
let easyOCRInstance: import("node-easyocr").EasyOCR | null = null;
let easyOCRInitPromise: Promise<import("node-easyocr").EasyOCR | null> | null = null;
let easyOCRAvailable: boolean | null = null;

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
 * Times out after 10 seconds to fall back to Tesseract
 */
async function getEasyOCR(): Promise<import("node-easyocr").EasyOCR | null> {
    if (easyOCRAvailable === false) {
        return null;
    }

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
            await withTimeout(ocr.init(languages), 10000, "EasyOCR init timeout");
            easyOCRInstance = ocr;
            easyOCRAvailable = true;
            return ocr;
        } catch {
            easyOCRAvailable = false;
            return null;
        }
    })();

    return easyOCRInitPromise;
}

/**
 * Initialize Tesseract worker (fallback)
 */
async function getTesseractWorker(): Promise<Worker> {
    if (cachedTesseractWorker) {
        return cachedTesseractWorker;
    }

    if (tesseractWorkerPromise) {
        return tesseractWorkerPromise;
    }

    tesseractWorkerPromise = (async () => {
        const worker = await createWorker("eng", 1, {
            logger: () => {} // Suppress progress logs
        });
        cachedTesseractWorker = worker;
        return worker;
    })();

    return tesseractWorkerPromise;
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
 * Run OCR using EasyOCR (better for colored backgrounds)
 */
async function runEasyOCR(
    imageBuffer: Buffer,
    scaleFactor: number,
    platform: "ios" | "android",
    devicePixelRatio: number
): Promise<OCRResult | null> {
    const startTime = Date.now();

    const ocr = await getEasyOCR();
    if (!ocr) {
        return null;
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

/**
 * Run OCR using Tesseract (fallback)
 */
async function runTesseract(
    imageBuffer: Buffer,
    scaleFactor: number,
    platform: "ios" | "android",
    devicePixelRatio: number
): Promise<OCRResult> {
    const startTime = Date.now();

    try {
        // Preprocess for Tesseract
        const processedImage = await sharp(imageBuffer)
            .normalize()
            .sharpen({ sigma: 1.5 })
            .toBuffer();

        const worker = await getTesseractWorker();
        const { data } = await worker.recognize(processedImage, {}, { blocks: true, text: true });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyData = data as any;

        const allWords: OCRWord[] = [];
        const allLines: OCRLine[] = [];

        if (anyData.blocks && Array.isArray(anyData.blocks)) {
            for (const block of anyData.blocks) {
                if (block.paragraphs) {
                    for (const para of block.paragraphs) {
                        if (para.lines) {
                            for (const line of para.lines) {
                                if (line.text && line.bbox) {
                                    const centerX = Math.round((line.bbox.x0 + line.bbox.x1) / 2);
                                    const centerY = Math.round((line.bbox.y0 + line.bbox.y1) / 2);
                                    allLines.push({
                                        text: line.text.trim(),
                                        confidence: line.confidence || 90,
                                        bbox: line.bbox,
                                        center: { x: centerX, y: centerY },
                                        tapCenter: {
                                            x: toTapCoord(centerX, scaleFactor, platform, devicePixelRatio),
                                            y: toTapCoord(centerY, scaleFactor, platform, devicePixelRatio)
                                        }
                                    });
                                }
                                if (line.words) {
                                    for (const word of line.words) {
                                        if (word.text && word.bbox) {
                                            const centerX = Math.round((word.bbox.x0 + word.bbox.x1) / 2);
                                            const centerY = Math.round((word.bbox.y0 + word.bbox.y1) / 2);
                                            allWords.push({
                                                text: word.text.trim(),
                                                confidence: word.confidence || 90,
                                                bbox: word.bbox,
                                                center: { x: centerX, y: centerY },
                                                tapCenter: {
                                                    x: toTapCoord(centerX, scaleFactor, platform, devicePixelRatio),
                                                    y: toTapCoord(centerY, scaleFactor, platform, devicePixelRatio)
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        return {
            success: true,
            fullText: anyData.text || "",
            confidence: anyData.confidence || 0,
            words: allWords,
            lines: allLines,
            processingTimeMs: Date.now() - startTime,
            engine: "tesseract"
        };
    } catch {
        return {
            success: false,
            fullText: "",
            confidence: 0,
            words: [],
            lines: [],
            processingTimeMs: Date.now() - startTime,
            engine: "tesseract"
        };
    }
}

/**
 * Main OCR function - tries EasyOCR first (better for colors), falls back to Tesseract
 */
export async function recognizeText(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    const scaleFactor = options?.scaleFactor ?? 1;
    const platform = options?.platform ?? "ios";
    const engine = options?.engine ?? "auto";
    const devicePixelRatio = options?.devicePixelRatio ?? 3;

    // If tesseract explicitly requested, use it
    if (engine === "tesseract") {
        return runTesseract(imageBuffer, scaleFactor, platform, devicePixelRatio);
    }

    // If easyocr explicitly requested, try it (fail if not available)
    if (engine === "easyocr") {
        const easyResult = await runEasyOCR(imageBuffer, scaleFactor, platform, devicePixelRatio);
        if (easyResult) {
            return easyResult;
        }
        // EasyOCR not available, return error result
        return {
            success: false,
            fullText: "",
            confidence: 0,
            words: [],
            lines: [],
            processingTimeMs: 0,
            engine: "easyocr"
        };
    }

    // Auto mode: Try EasyOCR first (better for white text on colored backgrounds)
    const easyResult = await runEasyOCR(imageBuffer, scaleFactor, platform, devicePixelRatio);
    if (easyResult) {
        return easyResult;
    }

    // Fall back to Tesseract
    return runTesseract(imageBuffer, scaleFactor, platform, devicePixelRatio);
}

export async function terminateOCRWorker(): Promise<void> {
    if (cachedTesseractWorker) {
        await cachedTesseractWorker.terminate();
        cachedTesseractWorker = null;
        tesseractWorkerPromise = null;
    }

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
