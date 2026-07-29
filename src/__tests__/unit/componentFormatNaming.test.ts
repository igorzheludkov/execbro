// The word "tonl" named two unrelated things: an npm package that made log
// output larger, and these hand-written formatters that make component output
// 5-6x smaller. The package is gone; this pins the survivors' new name so the
// ambiguity cannot creep back.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

describe("component formatter naming", () => {
    it("no production source file mentions tonl", () => {
        // Case-SENSITIVE on purpose. A case-insensitive match also hits
        // unrelated identifiers that merely contain the letters t-o-n-l --
        // e.g. isEvalTimeoutOnLiveSocket ("tOnL") -- and would force renaming
        // code that has nothing to do with this format.
        // __tests__ is excluded because this very file contains the string
        // in its own pattern and comments, which would be self-defeating.
        const hits = execSync(
            "grep -rlE 'tonl|Tonl|TONL' src/ --exclude-dir=__tests__ || true",
            { cwd: process.cwd(), encoding: "utf8" }
        ).trim();
        expect(hits).toBe("");
    });

    it("exposes the compact formatters under their new names", () => {
        const tree = readFileSync(join(process.cwd(), "src/core/componentTree.ts"), "utf8");
        const search = readFileSync(join(process.cwd(), "src/core/componentSearch.ts"), "utf8");
        const layout = readFileSync(join(process.cwd(), "src/core/screenLayout.ts"), "utf8");
        expect(tree).toContain("formatTreeCompact");
        expect(search).toContain("formatFoundComponentsCompact");
        expect(layout).toContain("formatSummaryCompact");
    });
});
