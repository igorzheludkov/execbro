import { describe, it, expect } from "@jest/globals";
import { textEntryAxes, type TextEntryResult } from "../../core/textEntry.js";

describe("textEntryAxes", () => {
    it("has no opinion on meaningfulness when nothing was written", () => {
        const miss: TextEntryResult = { success: false, error: "no TextInput matched that target", candidates: [] };
        const axes = textEntryAxes(miss);

        expect(axes.wrote).toBe(false);
        // Not `false` — a call that never wrote cannot have failed to land, and
        // recording it as a landing failure is what made the two axes one.
        expect(axes.meaningful).toBeUndefined();
        expect(axes.artifactOutcome).toBe("failure");
    });

    it("reports a verified write as landed", () => {
        const ok: TextEntryResult = { success: true, path: "react", verified: true, value: "Q3 budget" };
        expect(textEntryAxes(ok)).toEqual({ wrote: true, meaningful: true, artifactOutcome: null });
    });

    // The blind spot this whole change exists to close: these returned success
    // and telemetry recorded them as clean.
    it("reports an unverifiable write as NOT landed, and captures it", () => {
        const unverified: TextEntryResult = {
            success: true, path: "native", verified: false,
            error: "this field is uncontrolled and could not be located in the accessibility tree"
        };
        const axes = textEntryAxes(unverified);

        expect(axes.wrote).toBe(true);
        expect(axes.meaningful).toBe(false);
        expect(axes.artifactOutcome).toBe("unmeaningful");
    });

    it("reports a mismatch as a write that did not land", () => {
        const mismatch: TextEntryResult = {
            success: false, path: "hid", verified: false,
            sent: "5551234567", landed: "(555) 123-4567",
            error: "text landed differently than it was sent"
        };
        const axes = textEntryAxes(mismatch);

        expect(axes.wrote).toBe(true);
        expect(axes.meaningful).toBe(false);
        expect(axes.artifactOutcome).toBe("failure");
    });

    it("treats a decorated value as landed — the write was fine", () => {
        const decorated: TextEntryResult = {
            success: true, path: "react", verified: true, formatted: true, value: "$55.55"
        };
        expect(textEntryAxes(decorated).meaningful).toBe(true);
    });

    // No screen to photograph, and tap skips these for the same reason.
    it("captures nothing when the tool never reached the screen", () => {
        const dead: TextEntryResult = { success: false, error: "No apps connected. Run 'scan_metro' first." };
        const axes = textEntryAxes(dead);

        expect(axes.wrote).toBe(false);
        expect(axes.artifactOutcome).toBeNull();
    });
});
