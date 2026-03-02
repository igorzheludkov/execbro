import { describe, it, expect } from "@jest/globals";
import { BundleErrorBuffer, BundleError } from "../../core/bundle.js";

function makeError(message: string, type: BundleError["type"] = "other"): BundleError {
    return { timestamp: new Date(), type, message };
}

describe("BundleErrorBuffer", () => {
    let buffer: BundleErrorBuffer;

    beforeEach(() => {
        buffer = new BundleErrorBuffer(3);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
        expect(buffer.getLatest()).toBeNull();
    });

    it("adds errors and sets hasError status", () => {
        buffer.add(makeError("syntax error", "syntax"));
        expect(buffer.size).toBe(1);
        expect(buffer.getStatus().hasError).toBe(true);
    });

    it("getLatest() returns most recent error", () => {
        buffer.add(makeError("first"));
        buffer.add(makeError("second"));
        expect(buffer.getLatest()?.message).toBe("second");
    });

    it("evicts oldest when exceeding maxSize", () => {
        for (let i = 0; i < 5; i++) buffer.add(makeError(`err-${i}`));
        expect(buffer.size).toBe(3);
        const all = buffer.get();
        expect(all[0].message).toBe("err-2");
    });

    it("get(count) returns last N errors", () => {
        for (let i = 0; i < 3; i++) buffer.add(makeError(`err-${i}`));
        const last2 = buffer.get(2);
        expect(last2).toHaveLength(2);
        expect(last2[0].message).toBe("err-1");
    });

    it("clear() empties buffer and resets hasError", () => {
        buffer.add(makeError("err"));
        expect(buffer.clear()).toBe(1);
        expect(buffer.size).toBe(0);
        expect(buffer.getStatus().hasError).toBe(false);
    });

    it("updateStatus() merges partial status", () => {
        buffer.updateStatus({ isBuilding: true, buildTime: 500 });
        const status = buffer.getStatus();
        expect(status.isBuilding).toBe(true);
        expect(status.buildTime).toBe(500);
        expect(status.hasError).toBe(false);
    });
});
