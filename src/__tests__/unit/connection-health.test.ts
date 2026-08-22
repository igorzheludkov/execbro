import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
    getLastCDPMessageTime,
    updateLastCDPMessageTime,
    clearLastCDPMessageTime,
    clearAllCDPMessageTimes,
} from "../../core/state.js";
import { describeConnectionFailure } from "../../core/connection.js";

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

describe("describeConnectionFailure (Metro inspector auth rejection)", () => {
    it("rewrites the ws library's 401 into actionable guidance", () => {
        const out = describeConnectionFailure("Unexpected server response: 401");
        expect(out).toContain("HTTP 401 (authentication required)");
        expect(out).toContain("authenticating proxy or tunnel");
        expect(out).toContain("NO_PROXY");
        expect(out).toContain("Original error: Unexpected server response: 401");
    });

    it("treats 403 as the same class", () => {
        expect(describeConnectionFailure("Unexpected server response: 403"))
            .toContain("HTTP 403 (authentication required)");
    });

    it("passes every other error through byte-for-byte", () => {
        for (const msg of [
            "connect ECONNREFUSED 127.0.0.1:8081",
            "WebSocket connection timed out",
            "Unexpected server response: 404",
            "socket hang up",
            "",
        ]) {
            expect(describeConnectionFailure(msg)).toBe(msg);
        }
    });
});
