import { describe, it, expect, afterEach } from "@jest/globals";
import { initConnectionState, recordConnectionGap, getRecentGaps, clearConnectionState, clearAllConnectionState } from "../../core/connectionState.js";

afterEach(() => clearAllConnectionState());

describe("clearConnectionState", () => {
    it("drops a closed window's open gap, so other devices' reads stop warning 'disconnected'", () => {
        initConnectionState("9222-closed");
        initConnectionState("8081-iphone");
        recordConnectionGap("9222-closed", "Connection closed");
        expect(getRecentGaps(30_000)).toHaveLength(1);
        clearConnectionState("9222-closed");
        expect(getRecentGaps(30_000)).toEqual([]);
    });
});
