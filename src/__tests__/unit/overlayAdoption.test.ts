import { describe, it, expect } from "@jest/globals";
import { adoptsByContainment } from "../../core/injected/overlayAdoption.js";

/**
 * Regression cover for the rule that decides whether an overlay may claim a pressable
 * fiber ancestry did not give it. Geometry alone said yes to the screen *behind* the
 * overlay, which is how an RN <Modal> holding one CLOSE button came to report the six
 * buttons underneath it as its own contents — i.e. as reachable, when the modal is
 * exactly what blocks them (verified on the test app, 2026-09-04).
 */

/** Overlay entered at paint position 10, content rect covering most of the screen. */
const overlay = { hasContent: true, enterIdx: 10, contentBounds: { x: 0, y: 0, width: 1000, height: 2000 } };

const boxInside = { x: 100, y: 100, width: 200, height: 80 };

describe("adoptsByContainment", () => {
    it("adopts content painted after the overlay and inside its rect", () => {
        expect(adoptsByContainment({ overlayIdx: null, paintIdx: 20, bounds: boxInside }, overlay)).toBe(true);
    });

    it("refuses a pressable painted before the overlay", () => {
        // The screen behind. Geometrically inside, and the whole bug.
        expect(adoptsByContainment({ overlayIdx: null, paintIdx: 3, bounds: boxInside }, overlay)).toBe(false);
    });

    it("refuses a pressable painted at the overlay's own entry point", () => {
        expect(adoptsByContainment({ overlayIdx: null, paintIdx: 10, bounds: boxInside }, overlay)).toBe(false);
    });

    it("leaves a pressable that ancestry already assigned", () => {
        // Ancestry is authoritative; containment must not re-home it into another overlay.
        expect(adoptsByContainment({ overlayIdx: 2, paintIdx: 20, bounds: boxInside }, overlay)).toBe(false);
    });

    it("refuses when the overlay has no usable content rect", () => {
        // gorhom sheets measure only full-screen containers, so hasContent is false and
        // geometric adoption would swallow the underlying screen.
        expect(
            adoptsByContainment({ overlayIdx: null, paintIdx: 20, bounds: boxInside }, { ...overlay, hasContent: false })
        ).toBe(false);
    });

    it("refuses when the overlay was never entered during the walk", () => {
        expect(
            adoptsByContainment({ overlayIdx: null, paintIdx: 20, bounds: boxInside }, { ...overlay, enterIdx: -1 })
        ).toBe(false);
    });

    it("refuses a pressable that is only partly inside the content rect", () => {
        const straddling = { x: 900, y: 100, width: 400, height: 80 };
        expect(adoptsByContainment({ overlayIdx: null, paintIdx: 20, bounds: straddling }, overlay)).toBe(false);
    });

    it("accepts a pressable flush with the content rect edges", () => {
        const flush = { x: 0, y: 0, width: 1000, height: 2000 };
        expect(adoptsByContainment({ overlayIdx: null, paintIdx: 20, bounds: flush }, overlay)).toBe(true);
    });

    it("is emitted as plain JS with no TypeScript left in it", () => {
        // The same source is injected into Hermes via fn.toString(); a type annotation or
        // an optional chain surviving into that string is a syntax error on the device,
        // which fails as a broken screen read rather than as a build error here.
        const src = adoptsByContainment.toString();
        expect(src).not.toContain("?.");
        expect(src).not.toMatch(/:\s*(number|boolean|string)\b/);
    });
});
