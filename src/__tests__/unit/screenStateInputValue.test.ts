import { describe, expect, it } from "@jest/globals";
import { formatScreenStateSummary, type ScreenState, type ScreenStatePressable } from "../../core/screenState.js";

// A controlled TextInput keeps its text in props.value, not in a child text
// node. Before this change the label chain checked accessibilityLabel, then
// child text, then placeholder — so every field reported its placeholder as
// content, and the "type, then verify with get_screen_state" workflow we
// recommend read a stale placeholder and concluded the write had failed.

function input(over: Partial<ScreenStatePressable> = {}): ScreenStatePressable {
    return {
        label: "Search gifts, brands",
        component: "TextInput",
        center: { x: 183, y: 139 },
        bounds: { x: 60, y: 128, width: 246, height: 21 },
        testID: null,
        isInput: true,
        ...over
    };
}

function screen(pressables: ScreenStatePressable[]): ScreenState {
    return { route: null, overlays: [], pressables, texts: [], images: [] };
}

describe("get_screen_state input reporting", () => {
    it("renders the field's value, not its placeholder", () => {
        const out = formatScreenStateSummary(
            screen([input({ inputValue: "HELLO", inputPlaceholder: "Search gifts, brands" })]),
            undefined,
            { pressablesOnly: true }
        );
        expect(out).toContain('value:"HELLO"');
    });

    it("marks an empty field as empty and keeps the placeholder identifiable", () => {
        const out = formatScreenStateSummary(
            screen([input({ inputValue: null, inputPlaceholder: "Search gifts, brands" })]),
            undefined,
            { pressablesOnly: true }
        );
        expect(out).toContain("[input] empty");
        expect(out).toContain('placeholder:"Search gifts, brands"');
        expect(out).not.toContain('value:"Search gifts, brands"');
    });

    it("never lets a placeholder pose as a value", () => {
        const out = formatScreenStateSummary(
            screen([input({ inputValue: null, inputPlaceholder: "Enter email" })]),
            undefined,
            { pressablesOnly: true }
        );
        // The whole bug: an agent reading this line must not conclude the field
        // contains "Enter email".
        expect(out).not.toMatch(/value:"Enter email"/);
    });

    it("still marks inputs that report neither value nor placeholder", () => {
        const out = formatScreenStateSummary(screen([input()]), undefined, { pressablesOnly: true });
        expect(out).toContain("[input]");
    });

    it("leaves non-input pressables untouched", () => {
        const out = formatScreenStateSummary(
            screen([{ label: "Submit", center: { x: 1, y: 2 }, bounds: { x: 0, y: 0, width: 4, height: 4 }, testID: null }]),
            undefined,
            { pressablesOnly: true }
        );
        expect(out).toContain('"Submit"');
        expect(out).not.toContain("[input]");
    });
});
