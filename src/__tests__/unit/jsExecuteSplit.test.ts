import { describe, it, expect } from "@jest/globals";

const { splitTopLevelStatements, wrapMultiStatementInIife } = await import("../../core/jsExecute.js");

// Opus benchmark runs: scripts ending in `if (...) { ... } out` or
// `try {...} catch {...} ({...})` were rejected as "does not produce a value",
// because the final expression after a closing brace was glued to the block.
describe("splitTopLevelStatements", () => {
    it("returns a final expression that follows an if block without a semicolon", () => {
        expect(splitTopLevelStatements("var out = null; if (mods) { out = 1; } out")).toEqual([
            "var out = null",
            "if (mods) { out = 1; }",
            "out"
        ]);
        expect(wrapMultiStatementInIife("var out = null; if (mods) { out = 1; } out")).toBe(
            "(function(){ var out = null; if (mods) { out = 1; }; return out; })()"
        );
    });

    it("returns a final object literal that follows try/catch", () => {
        const src = "var err = null; try { f(); } catch (e) { err = String(e); } ({ err: err })";
        expect(splitTopLevelStatements(src).slice(-1)[0]).toBe("({ err: err })");
    });

    it("keeps if/else and try/catch/finally chains in one segment", () => {
        expect(splitTopLevelStatements("if (a) { x(); } else { y(); }")).toHaveLength(1);
        expect(splitTopLevelStatements("if (a) { x(); } /* c */ else if (b) { y(); } else { z(); }")).toHaveLength(1);
        expect(splitTopLevelStatements("try { x(); } catch (e) { y(); } finally { z(); }")).toHaveLength(1);
    });

    it("does not split an object literal or a function expression", () => {
        expect(splitTopLevelStatements("var o = { a: 1 }; o")).toEqual(["var o = { a: 1 }", "o"]);
        expect(splitTopLevelStatements("[1, 2].map(function (x) { return x; })")).toHaveLength(1);
    });
});
