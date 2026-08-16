import { describe, it, expect } from "@jest/globals";
import { fiberRootsMissing } from "../../core/jsExecute.js";

// This predicate decides whether executeInApp re-evaluates an expression. Matching
// too loosely runs a caller's side effects twice, matching too tightly leaves the
// "no fiber roots" / "found 20 components" contradiction in place.
describe("fiberRootsMissing", () => {
    it("matches every walker's phrasing, object or JSON", () => {
        expect(fiberRootsMissing({ error: "No fiber roots found." })).toBe(true);
        expect(fiberRootsMissing({ error: "No fiber roots found. The app may not have rendered yet." })).toBe(true);
        expect(fiberRootsMissing({ error: "No fiber roots found. Is a React Native app mounted?" })).toBe(true);
        expect(fiberRootsMissing(JSON.stringify({ error: "No fiber roots found." }))).toBe(true);
    });

    it("ignores other walker errors", () => {
        expect(fiberRootsMissing({ error: "React DevTools hook not found." })).toBe(false);
        expect(fiberRootsMissing({ count: 20 })).toBe(false);
        expect(fiberRootsMissing(null)).toBe(false);
        expect(fiberRootsMissing(undefined)).toBe(false);
    });

    it("does not re-run a user expression that merely mentions the phrase", () => {
        // Bare prose from execute_in_app: no {error} payload, so no retry.
        expect(fiberRootsMissing("No fiber roots found in my custom walk")).toBe(false);
        expect(fiberRootsMissing({ message: "No fiber roots found" })).toBe(false);
    });
});
