import { describe, it, expect } from "@jest/globals";
import { iconSemanticHint, iconLabel } from "../../core/iconSemantics.js";
import { applyIconHintToLabel, type ScreenStatePressable } from "../../core/screenState.js";

describe("iconSemanticHint", () => {
    it("maps chevron/arrow + direction composites", () => {
        expect(iconSemanticHint("SvgChevronBackward")).toBe("possibly back button");
        expect(iconSemanticHint("ChevronLeft")).toBe("possibly back button");
        expect(iconSemanticHint("ArrowRightIcon")).toBe("possibly forward/next button");
        expect(iconSemanticHint("CaretDown")).toBe("possibly expand/open button");
        expect(iconSemanticHint("chevron-up")).toBe("possibly collapse button");
    });

    it("maps standalone icon keywords", () => {
        expect(iconSemanticHint("SvgClose")).toBe("possibly close button");
        expect(iconSemanticHint("CheckboxOutline")).toBe("possibly checkbox");
        expect(iconSemanticHint("RadioOn")).toBe("possibly radio button");
        expect(iconSemanticHint("BackIcon")).toBe("possibly back button");
        expect(iconSemanticHint("IconTrashCan")).toBe("possibly delete button");
        expect(iconSemanticHint("HamburgerMenu")).toBe("possibly menu button");
        expect(iconSemanticHint("SearchOutline")).toBe("possibly search button");
        expect(iconSemanticHint("PlusCircle")).toBe("possibly add button");
        expect(iconSemanticHint("DotsVertical")).toBe("possibly more-options button");
    });

    it("prefers checkbox over check", () => {
        expect(iconSemanticHint("SvgCheckbox")).toBe("possibly checkbox");
        expect(iconSemanticHint("SvgCheckmark")).toBe("possibly confirm/check button");
    });

    it("matches whole words only — no substring false positives", () => {
        expect(iconSemanticHint("FeedbackForm")).toBeNull();
        expect(iconSemanticHint("BackgroundView")).toBeNull();
        expect(iconSemanticHint("Checkout")).toBeNull();
        expect(iconSemanticHint("StarterKit")).toBeNull();
    });

    it("returns null for non-icon names and empty input", () => {
        expect(iconSemanticHint("FloatingHeader")).toBeNull();
        expect(iconSemanticHint("SneakerCard")).toBeNull();
        expect(iconSemanticHint(null)).toBeNull();
        expect(iconSemanticHint(undefined)).toBeNull();
        expect(iconSemanticHint("")).toBeNull();
    });
});

describe("iconLabel", () => {
    it("combines the icon component name with the hint", () => {
        expect(iconLabel("FloatingHeader", "SvgChevronBackward")).toBe("SvgChevronBackward — possibly back button");
    });

    it("falls back to the component name when no icon child is known", () => {
        expect(iconLabel("CloseIcon", null)).toBe("CloseIcon — possibly close button");
    });

    it("returns null when neither name carries icon semantics", () => {
        expect(iconLabel("FloatingHeader", null)).toBeNull();
        expect(iconLabel("FloatingHeader", "FancyDecoration")).toBeNull();
    });
});

describe("applyIconHintToLabel", () => {
    function pressable(overrides: Partial<ScreenStatePressable> = {}): ScreenStatePressable {
        return {
            label: "[FloatingHeader]",
            center: { x: 40, y: 100 },
            bounds: { x: 16, y: 76, width: 48, height: 48 },
            testID: null,
            ...overrides,
        };
    }

    it("rewrites a fallback label using the icon hint", () => {
        const p = applyIconHintToLabel(pressable({ icon: "SvgChevronBackward" }));
        expect(p.label).toBe("[SvgChevronBackward — possibly back button]");
    });

    it("keeps the existing label when the icon name has no semantics", () => {
        const p = applyIconHintToLabel(pressable({ icon: "FancyDecoration" }));
        expect(p.label).toBe("[FloatingHeader]");
    });

    it("uses the icon name when there is no label at all", () => {
        const p = applyIconHintToLabel(pressable({ label: null, icon: "FancyDecoration" }));
        expect(p.label).toBe("[FancyDecoration]");
    });

    it("never touches text/a11y labels (icon is null for those)", () => {
        const p = applyIconHintToLabel(pressable({ label: "Submit", icon: null }));
        expect(p.label).toBe("Submit");
    });
});
