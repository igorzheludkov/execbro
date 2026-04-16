import { describe, it, expect } from "@jest/globals";
import { matchFiberCandidates, type PressableCandidate } from "../../core/fiberMatch.js";

function candidate(overrides: Partial<PressableCandidate> = {}): PressableCandidate {
    return {
        name: "Pressable",
        meaningfulComponentName: null,
        text: "",
        testID: null,
        ancestorTestIDs: [],
        isInput: false,
        isPressable: true,
        source: "direct",
        ...overrides,
    };
}

describe("matchFiberCandidates", () => {
    it("matches pressable by its own testID (regression)", () => {
        const list = [
            candidate({ testID: "other" }),
            candidate({ testID: "submit-btn" }),
            candidate({ testID: null }),
        ];
        const r = matchFiberCandidates(list, { testID: "submit-btn" });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(1);
        expect(r!.totalMatches).toBe(1);
    });

    it("matches pressable by ancestor testID when its own testID does not match", () => {
        const list = [
            candidate({ testID: null, ancestorTestIDs: ["walk-detail-delete-button"] }),
            candidate({ testID: "other", ancestorTestIDs: ["unrelated"] }),
        ];
        const r = matchFiberCandidates(list, { testID: "walk-detail-delete-button" });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(0);
    });

    it("matches pressable by its own fiber name (regression)", () => {
        const list = [
            candidate({ name: "Pressable" }),
            candidate({ name: "TouchableOpacity" }),
        ];
        const r = matchFiberCandidates(list, { component: "Touchable" });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(1);
    });

    it("matches pressable by meaningfulComponentName when own name is generic", () => {
        const list = [
            candidate({ name: "Pressable", meaningfulComponentName: "AddDetailsButton" }),
            candidate({ name: "Pressable", meaningfulComponentName: "OtherButton" }),
        ];
        const r = matchFiberCandidates(list, { component: "AddDetailsButton" });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(0);
    });

    it("component matching is case-insensitive substring", () => {
        const list = [candidate({ name: "Pressable", meaningfulComponentName: "PickerTrigger" })];
        const r = matchFiberCandidates(list, { component: "picker" });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(0);
    });

    it("respects index when multiple candidates match", () => {
        const list = [
            candidate({ name: "Pressable", meaningfulComponentName: "RowButton", text: "A" }),
            candidate({ name: "Pressable", meaningfulComponentName: "RowButton", text: "B" }),
            candidate({ name: "Pressable", meaningfulComponentName: "RowButton", text: "C" }),
        ];
        const r = matchFiberCandidates(list, { component: "RowButton", index: 2 });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(2);
        expect(r!.totalMatches).toBe(3);
        expect(r!.allMatches).toEqual([0, 1, 2]);
    });

    it("returns null when nothing matches", () => {
        const list = [candidate({ testID: "a", name: "Pressable" })];
        const r = matchFiberCandidates(list, { testID: "does-not-exist" });
        expect(r).toBeNull();
    });

    it("returns null when index is out of range", () => {
        const list = [candidate({ testID: "a" })];
        const r = matchFiberCandidates(list, { testID: "a", index: 3 });
        expect(r).toBeNull();
    });

    it("combines text, testID, and component with AND semantics", () => {
        const list = [
            candidate({
                name: "Pressable",
                meaningfulComponentName: "SubmitButton",
                testID: "submit",
                text: "Send it",
            }),
            candidate({
                name: "Pressable",
                meaningfulComponentName: "SubmitButton",
                testID: "submit",
                text: "Cancel",
            }),
        ];
        const r = matchFiberCandidates(list, {
            text: "send",
            testID: "submit",
            component: "SubmitButton",
        });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(0);
        expect(r!.totalMatches).toBe(1);
    });

    it("text matching is case-insensitive substring", () => {
        const list = [candidate({ text: "Hello World" })];
        const r = matchFiberCandidates(list, { text: "hello" });
        expect(r).not.toBeNull();
        expect(r!.matchIndex).toBe(0);
    });
});
