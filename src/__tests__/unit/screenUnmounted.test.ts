import { describe, it, expect } from "@jest/globals";
import { screenLooksUnmounted } from "../../pro/tap.js";
import type { EvidenceSink } from "../../pro/tap.js";

function sink(over: Partial<{
    fiberRan: boolean; fiberCount: number; a11yRan: boolean; a11yCount: number;
}> = {}): EvidenceSink {
    const { fiberRan = true, fiberCount = 0, a11yRan = true, a11yCount = 0 } = over;
    return {
        fiber: {
            ran: fiberRan,
            durationMs: 1,
            metroConnected: true,
            pressables: Array.from({ length: fiberCount }, () => ({ label: "x" })),
        },
        accessibility: {
            ran: a11yRan,
            durationMs: 1,
            elements: Array.from({ length: a11yCount }, () => ({ label: "x" })),
        },
    } as EvidenceSink;
}

// Gates whether tap settles-and-retries instead of letting OCR guess. A false
// positive costs one 400ms settle; a false negative is the original bug.
describe("screenLooksUnmounted", () => {
    it("fires when both trees ran and both are empty", () => {
        expect(screenLooksUnmounted(sink())).toBe(true);
    });

    it("does not fire when either tree saw anything", () => {
        expect(screenLooksUnmounted(sink({ fiberCount: 3 }))).toBe(false);
        expect(screenLooksUnmounted(sink({ a11yCount: 1 }))).toBe(false);
    });

    it("does not fire when a strategy never ran — that proves nothing", () => {
        expect(screenLooksUnmounted(sink({ fiberRan: false }))).toBe(false);
        expect(screenLooksUnmounted(sink({ a11yRan: false }))).toBe(false);
        expect(screenLooksUnmounted(undefined)).toBe(false);
    });
});
