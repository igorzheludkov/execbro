// The regions only matter if they reach the agent. compareScreenshots is
// covered in screenshot-diff.test.ts; this pins the sentence tap actually
// returns, which is the surface an agent reads.

process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect } from "@jest/globals";
import { buildVerificationExplanation } from "../../pro/tap.js";

const base = { meaningful: true, changeRate: 0.032, changedPixels: 3200, totalPixels: 100000 };

describe("verification explanation with regions", () => {
    it("names where the screen changed, as a point another tool can take", () => {
        const text = buildVerificationExplanation({
            ...base,
            regions: [{ x: 100, y: 200, width: 80, height: 40, changedPixels: 3200 }],
        });
        // Centre of the box, which is what you would hand to inspect_at_point.
        expect(text).toContain("(140, 220)");
        expect(text).toContain("80x40px");
        expect(text).toContain("inspect_at_point");
    });

    it("lists several changed areas rather than one box covering both", () => {
        const text = buildVerificationExplanation({
            ...base,
            regions: [
                { x: 0, y: 0, width: 32, height: 32, changedPixels: 1024 },
                { x: 160, y: 400, width: 32, height: 32, changedPixels: 1024 },
            ],
        });
        expect(text).toContain("2 changed areas");
        expect(text).toContain("(16, 16)");
        expect(text).toContain("(176, 416)");
    });

    it("keeps the caveat — a box locates the change, it does not identify the element", () => {
        const text = buildVerificationExplanation({
            ...base,
            regions: [{ x: 10, y: 10, width: 16, height: 16, changedPixels: 256 }],
        });
        expect(text).toContain("cannot identify which element");
    });

    it("reads exactly as before when no regions were computed", () => {
        // verify=false and the burst loop both land here; the wording must not
        // sprout a dangling fragment.
        const text = buildVerificationExplanation(base);
        expect(text).not.toContain("Changed area");
        expect(text).not.toContain("undefined");
        expect(text).toContain("caused a visible UI change (3.2% pixel diff).");
    });

    it("says nothing about location when the tap missed", () => {
        const text = buildVerificationExplanation({ ...base, meaningful: false, regions: [] });
        expect(text).toContain("No visual change detected");
        expect(text).not.toContain("Changed area");
    });
});
