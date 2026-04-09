import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
    getLastCDPMessageTime,
    updateLastCDPMessageTime,
    clearLastCDPMessageTime,
    clearAllCDPMessageTimes,
} from "../../core/state.js";

describe("lastCDPMessageAt tracking (per-device)", () => {
    beforeEach(() => {
        clearAllCDPMessageTimes();
    });

    it("returns null for unknown appKey", () => {
        expect(getLastCDPMessageTime("8081-device1")).toBeNull();
    });

    it("returns null when called with no appKey (global fallback)", () => {
        expect(getLastCDPMessageTime()).toBeNull();
    });

    it("updates per appKey", () => {
        const now = new Date();
        updateLastCDPMessageTime("8081-device1", now);
        expect(getLastCDPMessageTime("8081-device1")).toBe(now);
        expect(getLastCDPMessageTime("8081-device2")).toBeNull();
    });

    it("global fallback returns most recent across all devices", () => {
        const older = new Date("2026-01-01");
        const newer = new Date("2026-01-02");
        updateLastCDPMessageTime("8081-device1", older);
        updateLastCDPMessageTime("8081-device2", newer);
        expect(getLastCDPMessageTime()).toEqual(newer);
    });

    it("clearLastCDPMessageTime removes a specific device", () => {
        updateLastCDPMessageTime("8081-device1", new Date());
        clearLastCDPMessageTime("8081-device1");
        expect(getLastCDPMessageTime("8081-device1")).toBeNull();
    });

    it("clearAllCDPMessageTimes removes all entries", () => {
        updateLastCDPMessageTime("8081-device1", new Date());
        updateLastCDPMessageTime("8081-device2", new Date());
        clearAllCDPMessageTimes();
        expect(getLastCDPMessageTime()).toBeNull();
    });
});
