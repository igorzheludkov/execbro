import { describe, expect, it } from "@jest/globals";
import { formatScreenStateSummary, type ScreenState, type ScreenStatePressable } from "../../core/screenState.js";

// A Switch has onValueChange and no onPress, so it used to appear in no branch
// of the pressable walk at all: a settings row read as text at the label's
// coordinates and the control on the right was invisible. Flipping one meant
// guessing an x from a screenshot, and a guess that lands on the neighbouring
// row is indistinguishable from a correct toggle in tap's pixel diff.

function toggle(over: Partial<ScreenStatePressable> = {}): ScreenStatePressable {
    return {
        label: "Push notifications",
        component: "Switch",
        center: { x: 775, y: 320 },
        bounds: { x: 745, y: 305, width: 60, height: 30 },
        testID: "settings-push",
        ...over
    };
}

const screen = (pressables: ScreenStatePressable[]): ScreenState =>
    ({ route: null, overlays: [], pressables, texts: [], images: [] });

describe("get_screen_state switch reporting", () => {
    it("lists a switch with its current value and a tappable testID", () => {
        const out = formatScreenStateSummary(screen([toggle({ switchValue: true })]), undefined, {
            pressablesOnly: true
        });
        expect(out).toContain("[switch:ON]");
        expect(out).toContain('testID="settings-push"');
        expect(out).toContain("(775, 320)");
    });

    it("distinguishes off from on", () => {
        const out = formatScreenStateSummary(screen([toggle({ switchValue: false })]), undefined, {
            pressablesOnly: true
        });
        expect(out).toContain("[switch:OFF]");
    });

    it("says nothing about elements that are not switches", () => {
        const out = formatScreenStateSummary(
            screen([toggle({ component: "Button", switchValue: undefined })]),
            undefined,
            { pressablesOnly: true }
        );
        expect(out).not.toContain("[switch:");
    });
});
