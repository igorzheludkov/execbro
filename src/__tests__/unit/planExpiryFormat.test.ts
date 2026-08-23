import { describe, it, expect } from "@jest/globals";
import { formatPlanExpiry } from "../../tools/metaTools.js";

describe("formatPlanExpiry", () => {
    it("formats a valid ISO string", () => {
        expect(formatPlanExpiry("2027-01-01T00:00:00.000Z")).not.toBeNull();
    });

    it("returns null for null, so the line is omitted rather than printed as the epoch", () => {
        // new Date(null) is 1970-01-01, NOT NaN. The previous guard only checked
        // Number.isNaN, so a null expiry rendered as "Plan expires: 1/1/1970".
        expect(formatPlanExpiry(null)).toBeNull();
    });

    it("returns null for undefined", () => {
        expect(formatPlanExpiry(undefined)).toBeNull();
    });

    it("returns null for an object, instead of [object Object]", () => {
        // A Firestore Timestamp reaching an older client serializes to
        // {_seconds,_nanoseconds}; the old String() fallback printed
        // "Plan expires: [object Object]".
        expect(formatPlanExpiry({ _seconds: 1, _nanoseconds: 0 })).toBeNull();
    });

    it("returns null for an unparseable string", () => {
        expect(formatPlanExpiry("not a date")).toBeNull();
    });

    it("returns null for the empty string", () => {
        expect(formatPlanExpiry("")).toBeNull();
    });
});
