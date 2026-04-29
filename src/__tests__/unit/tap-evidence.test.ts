import { describe, it, expect } from "@jest/globals";
import type { OCRResult } from "../../core/ocr.js";
import { findClosestOcrText, makeEmptyEvidenceSink } from "../../pro/tap.js";

function ocr(words: Array<{ text: string; confidence?: number }>): OCRResult {
    return {
        success: true,
        fullText: words.map(w => w.text).join(" "),
        confidence: 1,
        words: words.map(w => ({
            text: w.text,
            confidence: w.confidence ?? 0.9,
            bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
            center: { x: 5, y: 5 },
            tapCenter: { x: 5, y: 5 }
        })),
        lines: [],
        processingTimeMs: 0,
        engine: "easyocr"
    };
}

describe("makeEmptyEvidenceSink", () => {
    it("creates a sink with all strategies marked unset", () => {
        const sink = makeEmptyEvidenceSink();
        expect(sink.fiber.ran).toBe(false);
        expect(sink.fiber.durationMs).toBe(0);
        expect(sink.fiber.metroConnected).toBe(false);
        expect(sink.fiber.pressables).toEqual([]);
        expect(sink.accessibility.ran).toBe(false);
        expect(sink.accessibility.elements).toEqual([]);
        expect(sink.ocr.ran).toBe(false);
        expect(sink.ocr.detections).toEqual([]);
        expect(sink.ocr.closestMatch).toBeNull();
    });
});

describe("findClosestOcrText", () => {
    it("returns the highest-scoring word for a near-miss query", () => {
        const result = ocr([{ text: "Sign in" }, { text: "Cancel" }]);
        const m = findClosestOcrText(result, "Sing in");
        expect(m?.text).toBe("Sign in");
        expect(m?.score).toBeGreaterThanOrEqual(0.5);
    });

    it("returns an exact match with score 1", () => {
        const result = ocr([{ text: "Login" }, { text: "Cancel" }]);
        const m = findClosestOcrText(result, "Login");
        expect(m?.text).toBe("Login");
        expect(m?.score).toBe(1);
    });

    it("prefers a closer match over a further one", () => {
        const result = ocr([{ text: "Help" }, { text: "Settings" }, { text: "Set Up" }]);
        const m = findClosestOcrText(result, "Setting");
        expect(m?.text).toBe("Settings");
    });

    it("returns null when query is empty", () => {
        const result = ocr([{ text: "Login" }]);
        expect(findClosestOcrText(result, "")).toBeNull();
    });

    it("returns null when ocrResult has no words or lines", () => {
        const empty: OCRResult = {
            success: true,
            fullText: "",
            confidence: 0,
            words: [],
            lines: [],
            processingTimeMs: 0,
            engine: "easyocr"
        };
        expect(findClosestOcrText(empty, "anything")).toBeNull();
    });

    it("considers lines as well as words", () => {
        const result: OCRResult = {
            success: true,
            fullText: "Welcome back",
            confidence: 1,
            words: [],
            lines: [{
                text: "Welcome back",
                confidence: 0.9,
                bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
                center: { x: 5, y: 5 },
                tapCenter: { x: 5, y: 5 }
            }],
            processingTimeMs: 0,
            engine: "easyocr"
        };
        const m = findClosestOcrText(result, "Welcome bac");
        expect(m?.text).toBe("Welcome back");
        expect(m?.score).toBeGreaterThan(0.7);
    });
});
