import { resolveLogBuffer, resolveNetworkBuffer } from "../../core/toolHelpers.js";
import { getLogBuffer, getNetworkBuffer, logBuffers, networkBuffers, resetEpochs } from "../../core/state.js";

describe("buffer resolution while disconnected", () => {
    beforeEach(() => {
        logBuffers.clear();
        networkBuffers.clear();
        resetEpochs();
    });

    it("falls back to a buffered device name when nothing is connected", () => {
        getLogBuffer("iPhone 17 Pro").add({
            timestamp: new Date(),
            level: "log",
            message: "pre-restart",
        });
        expect(resolveLogBuffer("iPhone").getAll()[0].message).toBe("pre-restart");
    });

    it("matches case-insensitively", () => {
        getNetworkBuffer("sdk_gphone64_arm64");
        expect(() => resolveNetworkBuffer("GPHONE")).not.toThrow();
    });

    it("still throws when no buffer exists for the device either", () => {
        expect(() => resolveLogBuffer("nonexistent")).toThrow(/No connected device/);
    });
});
