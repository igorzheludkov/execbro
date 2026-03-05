import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { getLastCDPMessageTime, updateLastCDPMessageTime } from "../../core/state.js";

describe("lastCDPMessageAt tracking", () => {
    beforeEach(() => {
        updateLastCDPMessageTime(null);
    });

    it("starts as null", () => {
        expect(getLastCDPMessageTime()).toBeNull();
    });

    it("updates when called with a date", () => {
        const now = new Date();
        updateLastCDPMessageTime(now);
        expect(getLastCDPMessageTime()).toBe(now);
    });

    it("updates to latest value on subsequent calls", () => {
        const first = new Date("2026-01-01");
        const second = new Date("2026-01-02");
        updateLastCDPMessageTime(first);
        updateLastCDPMessageTime(second);
        expect(getLastCDPMessageTime()).toBe(second);
    });

    it("can be reset to null", () => {
        updateLastCDPMessageTime(new Date());
        updateLastCDPMessageTime(null);
        expect(getLastCDPMessageTime()).toBeNull();
    });
});
