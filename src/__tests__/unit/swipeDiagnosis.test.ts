import { describe, it, expect } from "@jest/globals";
import { explainNoOpSwipe, type ScrollProbe } from "../../core/swipeDiagnosis.js";

const start = { x: 400, y: 900 };

function probe(over: Partial<ScrollProbe> = {}): ScrollProbe {
    return { found: true, horizontal: false, offset: 500, maxOffset: 4820, component: "FlatList", ...over };
}

describe("explainNoOpSwipe", () => {
    // The point of the whole exercise: the old text listed three possibilities at once and
    // left the reader to tell them apart by hand. Each branch must name exactly one cause.
    it("says the gesture missed every scrollable surface, with the coordinates", () => {
        const out = explainNoOpSwipe({ found: false }, start);
        expect(out).toContain("no scroll view found under (400, 900)");
        expect(out).not.toContain("end-of-scroll");
    });

    it("reports already-at-top with the offset", () => {
        const out = explainNoOpSwipe(probe({ offset: 0 }), start);
        expect(out).toContain("offset unchanged at 0");
        expect(out).toContain("already at the top");
    });

    it("treats a subpixel offset as the top", () => {
        expect(explainNoOpSwipe(probe({ offset: 1 }), start)).toContain("already at the top");
    });

    it("reports already-at-end with the offset and its maximum", () => {
        const out = explainNoOpSwipe(probe({ offset: 4820, maxOffset: 4820 }), start);
        expect(out).toContain("offset unchanged at 4820 (max)");
        expect(out).toContain("already at the end");
    });

    it("reports a non-scrollable surface separately from an exhausted one", () => {
        const out = explainNoOpSwipe(probe({ offset: 0, maxOffset: 0 }), start);
        expect(out).toContain("not scrollable");
        expect(out).not.toContain("already at the end");
    });

    it("names the axis mismatch when the gesture crosses the surface's axis", () => {
        const out = explainNoOpSwipe(probe(), start, { dx: -400, dy: 0 });
        expect(out).toContain("wrong axis");
        expect(out).toContain("up/down");
    });

    it("does not cry axis mismatch when the axes agree", () => {
        const out = explainNoOpSwipe(probe({ offset: 0 }), start, { dx: 0, dy: -600 });
        expect(out).not.toContain("wrong axis");
        expect(out).toContain("already at the top");
    });

    it("falls through to 'did not reach it' only when mid-scroll on the right axis", () => {
        const out = explainNoOpSwipe(probe({ offset: 1648, maxOffset: 30036 }), start, { dx: 0, dy: -600 });
        expect(out).toContain("offset unchanged at 1648 of 30036");
        expect(out).toContain("did not reach it");
    });
});
