import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    markBundlePossiblyStale,
    clearBundleStale,
    bundleStaleWarning,
    staleBundleMessage,
    resetMetroIdentity,
} from "../../core/metroIdentity.js";

describe("stale-bundle tracking", () => {
    beforeEach(() => resetMetroIdentity());

    it("says nothing until a device is marked", () => {
        expect(bundleStaleWarning("iPhone Air")).toBeNull();
        expect(bundleStaleWarning()).toBeNull();
    });

    it("matches the fragment a caller actually passes", () => {
        markBundlePossiblyStale("iPhone Air", staleBundleMessage("iPhone Air"));
        // Callers address devices by whatever substring they were handed, the same rule
        // device resolution uses — a warning that only fires on the exact name is a warning
        // that mostly does not fire.
        expect(bundleStaleWarning("iPhone")).toContain("STALE BUNDLE RISK");
        expect(bundleStaleWarning("iPhone Air")).toContain("STALE BUNDLE RISK");
    });

    it("does not warn about an unrelated device", () => {
        markBundlePossiblyStale("iPhone Air", staleBundleMessage("iPhone Air"));
        expect(bundleStaleWarning("sdk_gphone16k_arm64")).toBeNull();
    });

    it("falls back to any flagged device when none is named", () => {
        markBundlePossiblyStale("iPhone Air", staleBundleMessage("iPhone Air"));
        expect(bundleStaleWarning()).toContain("STALE BUNDLE RISK");
    });

    it("clears on reload, including via a name fragment", () => {
        markBundlePossiblyStale("iPhone Air", staleBundleMessage("iPhone Air"));
        clearBundleStale("iPhone");
        expect(bundleStaleWarning("iPhone Air")).toBeNull();
    });

    it("clears every device when reload names none", () => {
        markBundlePossiblyStale("iPhone Air", staleBundleMessage("iPhone Air"));
        markBundlePossiblyStale("sdk_gphone", staleBundleMessage("sdk_gphone"));
        clearBundleStale();
        expect(bundleStaleWarning("iPhone Air")).toBeNull();
        expect(bundleStaleWarning("sdk_gphone")).toBeNull();
    });

    it("names the device and the recovery in the message", () => {
        const msg = staleBundleMessage("iPhone Air");
        expect(msg).toContain("iPhone Air");
        expect(msg).toContain("reload_app");
        // The reason the warning exists at all: stale behaviour reads as a broken fix.
        expect(msg).toContain("not evidence");
    });
});
