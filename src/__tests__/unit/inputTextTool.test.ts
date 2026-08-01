import { describe, expect, it } from "@jest/globals";
import { formatTextEntryResponse } from "../../tools/interactionTools.js";

describe("formatTextEntryResponse", () => {
    it("reports the landed value and keyboard state on success", () => {
        const r = formatTextEntryResponse({
            success: true,
            value: "a@b",
            path: "react",
            verified: true,
            keyboard: { raised: true, changed: true }
        });
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).toContain('"a@b"');
        expect(r.content[0].text).toContain("keyboard: visible");
    });

    it("says when a retry was needed", () => {
        const r = formatTextEntryResponse({
            success: true,
            value: "CASEB",
            path: "react",
            verified: true,
            retried: true
        });
        expect(r.content[0].text).toContain("retried once");
    });

    it("marks a verified mismatch as an error naming sent and landed", () => {
        const r = formatTextEntryResponse({
            success: false,
            sent: "CASEB",
            landed: "CSEBA",
            retried: true,
            error: "text landed differently than it was sent"
        });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain("CASEB");
        expect(r.content[0].text).toContain("CSEBA");
    });

    it("lists the matching inputs when the target was ambiguous", () => {
        const r = formatTextEntryResponse({
            success: false,
            ambiguous: true,
            error: "7 inputs match this target",
            candidates: [
                { index: 0, component: "FormInput", label: "Title *", placeholder: "Type here", value: "", testID: "new-topic-title" },
                { index: 1, component: "FormInput", label: "Goal", placeholder: "Type here", value: "", testID: "new-topic-goal" }
            ]
        });
        expect(r.isError).toBe(true);
        const text = r.content[0].text;
        expect(text).toContain("Title *");
        expect(text).toContain("Goal");
        expect(text).toContain("0:");
        expect(text).toContain("1:");
        expect(text).toContain("index");
    });

    it("does not set isError when only the keyboard raise failed", () => {
        const r = formatTextEntryResponse({
            success: true,
            value: "hi",
            path: "react",
            verified: true,
            keyboard: { raised: false, changed: false, reason: "osascript error 1002" }
        });
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).toContain("1002");
    });

    it("flags an unverified success loudly without failing it", () => {
        const r = formatTextEntryResponse({
            success: true,
            path: "hid",
            verified: false,
            error: "the field exposes no readable value, so the text could not be confirmed"
        });
        expect(r.isError).toBeFalsy();
        // A caller skimming for success must not mistake this for a confirmed write.
        expect(r.content[0].text).toContain("UNVERIFIED");
    });

    it("says how many inputs were left out of a capped list", () => {
        // A cap that is not reported reads as "this is everything", which is how
        // a caller concludes its field is absent when it is simply past the cut.
        const r = formatTextEntryResponse({
            success: false,
            error: "no focused TextInput",
            totalInputs: 19,
            candidates: Array.from({ length: 12 }, (_, i) => ({
                index: i,
                component: "FormInput",
                label: `field ${i}`,
                placeholder: null,
                value: null,
                testID: null
            }))
        });
        expect(r.content[0].text).toContain("showing 12 of 19");
    });

    it("does not claim truncation when the whole list is shown", () => {
        const r = formatTextEntryResponse({
            success: false,
            error: "no focused TextInput",
            totalInputs: 2,
            candidates: [
                { index: 0, component: "FormInput", label: "a", placeholder: null, value: null, testID: null },
                { index: 1, component: "FormInput", label: "b", placeholder: null, value: null, testID: null }
            ]
        });
        expect(r.content[0].text).not.toContain("showing");
    });

    it("lists inputs on screen when nothing matched at all", () => {
        const r = formatTextEntryResponse({
            success: false,
            error: "no TextInput matched that target",
            candidates: [
                { index: 0, component: "FormInput", label: "Title *", placeholder: "Type here", value: null, testID: null }
            ]
        });
        expect(r.content[0].text).toContain("inputs on screen");
        expect(r.content[0].text).not.toContain("Re-run with index");
    });
});
