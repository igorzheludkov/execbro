import { describe, expect, it } from "@jest/globals";
import {
    formatKeyboardLine,
    partitionByKeyboard,
    formatScreenStateSummary,
    type ScreenState,
    type ScreenStatePressable
} from "../../core/screenState.js";
import type { KeyboardState } from "../../core/keyboardMetrics.js";

const up: KeyboardState = { visible: true, height: 345, screenY: 567, width: 420 };
const down: KeyboardState = { visible: false, height: null, screenY: null, width: null };

describe("formatKeyboardLine", () => {
    it("reports height and the remaining content area when visible", () => {
        const line = formatKeyboardLine(up);
        expect(line).toContain("345");
        expect(line).toContain("567");
    });

    it("renders nothing when the keyboard is down", () => {
        expect(formatKeyboardLine(down)).toBe("");
    });

    it("says unknown rather than nothing when the state could not be read", () => {
        // Silence would read as "keyboard is down", which is a different claim.
        const line = formatKeyboardLine({ ...down, error: "no Keyboard module" });
        expect(line).toContain("unknown");
        expect(line).toContain("no Keyboard module");
    });

    it("renders nothing when visible is true but metrics are missing", () => {
        expect(formatKeyboardLine({ visible: true, height: null, screenY: null, width: null })).toBe("");
    });
});

describe("partitionByKeyboard", () => {
    const item = (y: number, label: string) => ({
        label,
        center: { x: 10, y },
        bounds: { x: 0, y: y - 5, width: 20, height: 10 }
    });

    it("splits elements the keyboard covers from the reachable ones", () => {
        const { reachable, blocked } = partitionByKeyboard([item(100, "top"), item(800, "under")], up);
        expect(reachable.map((p) => p.label)).toEqual(["top"]);
        expect(blocked.map((p) => p.label)).toEqual(["under"]);
    });

    it("treats an element exactly on the keyboard edge as blocked", () => {
        const { blocked } = partitionByKeyboard([item(567, "edge")], up);
        expect(blocked.map((p) => p.label)).toEqual(["edge"]);
    });

    it("blocks nothing when the keyboard is down", () => {
        const { reachable, blocked } = partitionByKeyboard([item(100, "a"), item(800, "b")], down);
        expect(reachable).toHaveLength(2);
        expect(blocked).toHaveLength(0);
    });
});

describe("get_screen_state keyboard reporting", () => {
    const pressable = (y: number, label: string): ScreenStatePressable => ({
        label,
        center: { x: 210, y },
        bounds: { x: 20, y: y - 20, width: 380, height: 40 },
        testID: null
    });
    const screen = (pressables: ScreenStatePressable[]): ScreenState => ({
        route: null,
        overlays: [],
        pressables,
        texts: [],
        images: []
    });

    it("groups keyboard-covered elements separately", () => {
        const out = formatScreenStateSummary(screen([pressable(100, "Header"), pressable(841, "Home tab")]), undefined, {
            pressablesOnly: true,
            keyboard: up
        });
        expect(out).toContain("⌨️ Keyboard: visible");
        expect(out).toContain("Blocked by keyboard");
        const blockedIdx = out.indexOf("Blocked by keyboard");
        expect(out.indexOf("Home tab")).toBeGreaterThan(blockedIdx);
        expect(out.indexOf("Header")).toBeLessThan(blockedIdx);
    });

    it("adds nothing when no keyboard state was supplied", () => {
        const out = formatScreenStateSummary(screen([pressable(841, "Home tab")]), undefined, {
            pressablesOnly: true
        });
        expect(out).not.toContain("Keyboard");
        expect(out).not.toContain("Blocked by keyboard");
    });

    it("adds no blocked group when the keyboard is down", () => {
        const out = formatScreenStateSummary(screen([pressable(841, "Home tab")]), undefined, {
            pressablesOnly: true,
            keyboard: down
        });
        expect(out).not.toContain("Blocked by keyboard");
        expect(out).toContain("Home tab");
    });
});

describe("formatKeyboardLine rounding", () => {
    it("rounds Android's fractional dp to whole points", () => {
        const line = formatKeyboardLine({
            visible: true,
            height: 288.3809509277344,
            screenY: 587.047607421875,
            width: 411.4285583496094
        });
        expect(line).toContain("288pt");
        expect(line).toContain("411x587pt");
        expect(line).not.toContain(".");
    });
});
