import { describe, it, expect } from "@jest/globals";
import { formatPressabilityAudit } from "../../core/screenState.js";

/**
 * The audit exists because the screen-state walk is a filter over React Native's own
 * press-target markers, and every element it drops used to leave no trace: a shorter
 * list reads exactly like a screen with fewer buttons on it. Measured on the test app
 * (2026-09-04): 35 markers mounted, all 35 surviving both filters, so a healthy screen
 * must stay silent or the line becomes noise nobody reads.
 */
describe("formatPressabilityAudit", () => {
    it("says nothing when every marker survived", () => {
        expect(formatPressabilityAudit({ markerTotal: 35, markerHiddenCount: 0, markerUnmeasurableCount: 0 })).toBeNull();
    });

    it("says nothing when there are no markers at all", () => {
        // Old architecture, a production bundle, or a screen with no press targets.
        // Reporting "0 of 0" would be a warning about nothing.
        expect(formatPressabilityAudit({})).toBeNull();
        expect(formatPressabilityAudit({ markerTotal: 0, markerUnmeasurableCount: 0 })).toBeNull();
    });

    it("leads with unmeasurable targets, which are the anomalous ones", () => {
        const note = formatPressabilityAudit({
            markerTotal: 20,
            markerHiddenCount: 0,
            markerUnmeasurableCount: 3,
            markerSkipped: [{ id: "sheet-confirm", why: "host view is not measurable" }]
        })!;
        expect(note).toContain("3 of 20");
        expect(note).toContain("no measurable host view");
        expect(note).toContain("sheet-confirm");
        // The actionable half: this shape is transient, so a second read may show it.
        expect(note).toContain("re-read");
    });

    it("mentions hidden pruning alongside, without burying the anomaly", () => {
        const note = formatPressabilityAudit({
            markerTotal: 40,
            markerHiddenCount: 12,
            markerUnmeasurableCount: 2,
            markerSkipped: [{ id: "confirm-btn", why: "host view is not measurable" }]
        })!;
        expect(note.indexOf("2 of 40")).toBeLessThan(note.indexOf("12 more"));
    });

    it("reports hidden-only pruning as normal, not as a problem", () => {
        const note = formatPressabilityAudit({
            markerTotal: 40,
            markerHiddenCount: 15,
            markerUnmeasurableCount: 0,
            markerSkipped: [{ id: "settings-row", why: "pruned as hidden by Screen" }]
        })!;
        // Inactive navigator routes stay mounted, so this is the healthy case and must
        // not be phrased as a fault — it is a lookup aid for a missing element.
        expect(note).toContain("normally correct");
        expect(note).toContain("Screen");
        expect(note).not.toContain("NOT listed");
    });

    it("names the pruning rule so an unexpected pruner is identifiable", () => {
        const note = formatPressabilityAudit({
            markerTotal: 9,
            markerHiddenCount: 4,
            markerUnmeasurableCount: 0,
            markerSkipped: [{ id: "buy-now", why: "pruned as hidden by BottomSheetModal" }]
        })!;
        expect(note).toContain("BottomSheetModal");
        expect(note).toContain("buy-now");
    });

    it("caps the sample list so a broken screen cannot flood the output", () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `btn-${i}`, why: "host view is not measurable" }));
        const note = formatPressabilityAudit({
            markerTotal: 30,
            markerHiddenCount: 0,
            markerUnmeasurableCount: 12,
            markerSkipped: many
        })!;
        expect(note).toContain("btn-5");
        expect(note).not.toContain("btn-6");
    });
});

describe("formatPressabilityAudit — overlay reported empty", () => {
    it("flags an overlay listed with no pressables while targets exist", () => {
        // The Gorhom sheet case, verified on the emulator (2026-09-04): the sheet is open
        // with a visible CLOSE button, and the sheet group renders "(no pressables)".
        // Nothing pruned it — it is portaled outside the navigator — so the loss happens
        // while grouping, and this note is its only symptom.
        const note = formatPressabilityAudit({
            markerTotal: 47,
            markerHiddenCount: 0,
            markerUnmeasurableCount: 0,
            emptyOverlayGroups: ["BottomSheet"]
        })!;
        expect(note).toContain("BottomSheet");
        expect(note).toContain("47 press target(s)");
        expect(note).toContain("grouping fault");
    });

    it("takes precedence over routine pruning counts", () => {
        const note = formatPressabilityAudit({
            markerTotal: 35,
            markerHiddenCount: 22,
            markerUnmeasurableCount: 0,
            emptyOverlayGroups: ["BottomSheet"]
        })!;
        expect(note).toContain("grouping fault");
        expect(note).not.toContain("normally correct");
    });

    it("stays silent for a screen whose overlays all carry content", () => {
        expect(
            formatPressabilityAudit({
                markerTotal: 35,
                markerHiddenCount: 0,
                markerUnmeasurableCount: 0,
                emptyOverlayGroups: []
            })
        ).toBeNull();
    });
});
