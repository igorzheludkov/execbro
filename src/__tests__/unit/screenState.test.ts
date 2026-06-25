import { describe, it, expect } from "@jest/globals";
import {
    markPressablesCoveredByOverlay,
    parseScreenStateResponse,
    formatScreenStateSummary,
    describePressHandler,
    describePropHandlers,
    applyIconHintToLabel,
    type ScreenState,
    type ScreenStatePressable,
} from "../../core/screenState.js";

function pressable(overrides: Partial<ScreenStatePressable> = {}): ScreenStatePressable {
    return {
        label: "Button",
        center: { x: 100, y: 100 },
        bounds: { x: 80, y: 80, width: 40, height: 40 },
        testID: null,
        ...overrides,
    };
}

describe("markPressablesCoveredByOverlay", () => {
    const overlay = { x: 0, y: 400, width: 375, height: 300 };

    it("does not flag pressable fully above the overlay", () => {
        const p = pressable({ bounds: { x: 10, y: 50, width: 100, height: 44 } });
        const result = markPressablesCoveredByOverlay([p], overlay);
        expect(result[0].blockedByOverlay).toBeUndefined();
    });

    it("flags pressable fully inside the overlay bounds", () => {
        const p = pressable({ bounds: { x: 50, y: 450, width: 100, height: 44 } });
        const result = markPressablesCoveredByOverlay([p], overlay);
        expect(result[0].blockedByOverlay).toBe(true);
    });

    it("does not flag pressable that partially overlaps (only fully covered ones are blocked)", () => {
        const p = pressable({ bounds: { x: 50, y: 380, width: 100, height: 60 } });
        const result = markPressablesCoveredByOverlay([p], overlay);
        expect(result[0].blockedByOverlay).toBeUndefined();
    });

    it("handles empty pressables list", () => {
        expect(markPressablesCoveredByOverlay([], overlay)).toHaveLength(0);
    });
});

describe("parseScreenStateResponse", () => {
    it("returns null for null input", () => {
        expect(parseScreenStateResponse(null)).toBeNull();
    });

    it("returns null when response has error field", () => {
        expect(parseScreenStateResponse({ error: "No hook found" })).toBeNull();
    });

    it("parses a full response with route, overlays, and pressables", () => {
        const raw = {
            route: { name: "ProductDetails", params: { productId: "123" }, stack: ["Home", "ProductDetails"] },
            overlays: [
                {
                    type: "BottomSheet",
                    title: "Select Size",
                    pressables: [
                        { label: "S", center: { x: 70, y: 582 }, bounds: { x: 40, y: 560, width: 60, height: 44 }, testID: null },
                    ],
                },
            ],
            pressables: [
                { label: "Back", center: { x: 38, y: 78 }, bounds: { x: 16, y: 56, width: 44, height: 44 }, testID: null },
            ],
        };
        const result = parseScreenStateResponse(raw);
        expect(result).not.toBeNull();
        expect(result!.route!.name).toBe("ProductDetails");
        expect(result!.route!.stack).toEqual(["Home", "ProductDetails"]);
        expect(result!.overlays).toHaveLength(1);
        expect(result!.overlays[0].type).toBe("BottomSheet");
        expect(result!.overlays[0].pressables).toHaveLength(1);
        expect(result!.pressables).toHaveLength(1);
        expect(result!.pressables[0].label).toBe("Back");
    });

    it("parses a response with null route (no navigation library)", () => {
        const raw = { route: null, overlays: [], pressables: [] };
        const result = parseScreenStateResponse(raw);
        expect(result).not.toBeNull();
        expect(result!.route).toBeNull();
        expect(result!.overlays).toHaveLength(0);
    });

    it("defaults overlays and pressables to empty arrays when missing", () => {
        const raw = { route: null };
        const result = parseScreenStateResponse(raw);
        expect(result!.overlays).toEqual([]);
        expect(result!.pressables).toEqual([]);
    });

    it("parses texts and images arrays", () => {
        const parsed = parseScreenStateResponse({
            route: null,
            overlays: [],
            pressables: [],
            texts: [{ text: "Total", center: { x: 10, y: 20 }, bounds: { x: 0, y: 10, width: 40, height: 20 } }],
            images: [{ src: "https://x/y.jpg", alt: "hero", center: { x: 5, y: 5 }, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
        });
        expect(parsed?.texts).toHaveLength(1);
        expect(parsed?.texts[0].text).toBe("Total");
        expect(parsed?.images[0].src).toBe("https://x/y.jpg");
    });

    it("defaults texts and images to empty arrays when absent (back-compat)", () => {
        const parsed = parseScreenStateResponse({ route: null, overlays: [], pressables: [] });
        expect(parsed?.texts).toEqual([]);
        expect(parsed?.images).toEqual([]);
    });
});

describe("describePressHandler", () => {
    it("returns named handlers as calls", () => {
        expect(describePressHandler({ n: "handleSubmit", s: "" })).toBe("handleSubmit()");
        expect(describePressHandler({ n: "startProcessing", s: "function startProcessing() {…}" })).toBe("startProcessing()");
    });

    it("strips the 'bound ' prefix", () => {
        expect(describePressHandler({ n: "bound goBack", s: "" })).toBe("goBack()");
    });

    it("rejects generic and minified names, falling back to source", () => {
        expect(describePressHandler({ n: "onPress", s: "() => setAccepted(prev => !prev)" })).toBe("{() => setAccepted(prev => !prev)}");
        expect(describePressHandler({ n: "t12", s: "" })).toBeNull();
        expect(describePressHandler({ n: "anonymous", s: "" })).toBeNull();
        expect(describePressHandler({ n: "e", s: "" })).toBeNull();
    });

    it("truncates long source snippets", () => {
        const longSrc = "() => " + "x".repeat(100);
        const out = describePressHandler({ n: "", s: longSrc });
        expect(out).toContain("…");
        expect(out!.length).toBeLessThan(80);
    });

    it("returns null for bytecode bundles (source stripped in-app) and bad input", () => {
        expect(describePressHandler({ n: "", s: "" })).toBeNull();
        expect(describePressHandler(null)).toBeNull();
        expect(describePressHandler(undefined)).toBeNull();
    });
});

describe("describePropHandlers", () => {
    it("prefers the identity-matched prop and shows its named handler", () => {
        const raw = [
            { p: "onRightPress", n: "", same: false },
            { p: "onBack", n: "goBack", same: true },
        ];
        expect(describePropHandlers(raw)).toBe("onBack=goBack()");
    });

    it("reports the prop route when the matched handler is anonymous", () => {
        expect(describePropHandlers([{ p: "onBack", n: "", same: true }])).toBe("onPress→onBack");
    });

    it("suppresses a nameless plain onPress prop (adds nothing)", () => {
        expect(describePropHandlers([{ p: "onPress", n: "", same: true }])).toBeNull();
        expect(describePropHandlers([{ p: "onPress", n: "onPress", same: true }])).toBeNull();
    });

    it("ignores a lone non-identity-matched candidate (the touchable's onPress is some other internal handler)", () => {
        // A minified internal handler (e.g. handleCartPress) is NOT a pass-through of
        // the component's only on* prop (onBack). Guessing onBack here mislabels every
        // button in a multi-button container like FloatingHeader, so we emit nothing.
        expect(describePropHandlers([{ p: "onSelect", n: "", same: false }])).toBeNull();
        expect(describePropHandlers([{ p: "onBack", n: "", same: false }])).toBeNull();
    });

    it("picks the identity-matched prop even when other candidates exist", () => {
        const raw = [
            { p: "onMenuPress", n: "", same: false },
            { p: "onBack", n: "", same: true },
        ];
        expect(describePropHandlers(raw)).toBe("onPress→onBack");
    });

    it("returns null on ambiguity (several candidates, none identity-matched)", () => {
        const raw = [
            { p: "onBack", n: "", same: false },
            { p: "onRightPress", n: "", same: false },
        ];
        expect(describePropHandlers(raw)).toBeNull();
    });

    it("returns null for empty or malformed input", () => {
        expect(describePropHandlers(null)).toBeNull();
        expect(describePropHandlers([])).toBeNull();
        expect(describePropHandlers("nope")).toBeNull();
    });
});

describe("applyIconHintToLabel", () => {
    it("upgrades a fallback container label to the icon's semantic hint", () => {
        const p = pressable({ label: "[FloatingHeader]", icon: "SvgChevronBackward" });
        applyIconHintToLabel(p);
        expect(p.label).toBe("[SvgChevronBackward — possibly back button]");
    });

    it("upgrades a count-badge label to the icon hint and preserves the count as nearby text", () => {
        const p = pressable({ label: "1", icon: "SvgCartNew" });
        applyIconHintToLabel(p);
        expect(p.label).toBe("[SvgCartNew — possibly cart button]");
        expect(p.nearbyText).toBe("1");
    });

    it("treats a '99+' overflow badge as a count badge", () => {
        const p = pressable({ label: "99+", icon: "SvgCartNew" });
        applyIconHintToLabel(p);
        expect(p.label).toBe("[SvgCartNew — possibly cart button]");
        expect(p.nearbyText).toBe("99+");
    });

    it("does not overwrite existing nearby text when preserving a badge", () => {
        const p = pressable({ label: "2", icon: "SvgCartNew", nearbyText: "Checkout" });
        applyIconHintToLabel(p);
        expect(p.nearbyText).toBe("Checkout");
    });

    it("keeps the count badge as the label when the icon has no recognizable semantics", () => {
        const p = pressable({ label: "3", icon: "SvgBlob" });
        applyIconHintToLabel(p);
        expect(p.label).toBe("3");
        expect(p.nearbyText).toBeUndefined();
    });

    it("falls back to the bare icon name when there is no label and no hint", () => {
        const p = pressable({ label: null, icon: "SvgBlob" });
        applyIconHintToLabel(p);
        expect(p.label).toBe("[SvgBlob]");
    });

    it("leaves pressables without an icon untouched", () => {
        const p = pressable({ label: "Submit", icon: null });
        applyIconHintToLabel(p);
        expect(p.label).toBe("Submit");
    });
});

describe("formatScreenStateSummary", () => {
    const state: ScreenState = {
        route: { name: "Checkout", params: { id: "7" }, stack: ["Tabs", "Cart", "Checkout"] },
        overlays: [],
        pressables: [
            pressable({
                label: "Send",
                component: "Button",
                center: { x: 210, y: 838 },
                bounds: { x: 20, y: 810, width: 380, height: 56 },
            }),
            pressable({
                label: "[CheckBox — possibly confirm/check button]",
                component: "CheckBox",
                nearbyText: "Skip verification.",
                center: { x: 31, y: 719 },
                bounds: { x: 20, y: 708, width: 22, height: 22 },
            }),
        ],
        texts: [],
        images: [],
    };

    it("renders route, params, component tags, labels, nearby text, and frames", () => {
        const out = formatScreenStateSummary(state);
        expect(out).toContain('📍 Currently focused screen: "Checkout"  [navigation stack: Tabs > Cart > Checkout]');
        expect(out).toContain('route params: {"id":"7"}');
        expect(out).toContain('(210, 838) <Button /> "Send" frame:(20,810 380x56)');
        expect(out).toContain('near "Skip verification."');
    });

    it("applies the coordinate converter to centers and frames", () => {
        const out = formatScreenStateSummary(state, (p) => ({
            center: { x: p.center.x * 2, y: p.center.y * 2 },
            frame: { x: p.bounds.x * 2, y: p.bounds.y * 2, width: p.bounds.width * 2, height: p.bounds.height * 2 },
        }));
        expect(out).toContain('(420, 1676) <Button /> "Send" frame:(40,1620 760x112)');
    });

    it("groups overlay pressables and lists blocked root pressables separately", () => {
        const withOverlay: ScreenState = {
            route: null,
            overlays: [{ type: "BottomSheet", title: null, pressables: [pressable({ label: "Submit" })] }],
            pressables: [pressable({ label: "Send", blockedByOverlay: true })],
            texts: [],
            images: [],
        };
        const out = formatScreenStateSummary(withOverlay);
        expect(out).toContain("📍 Currently focused screen: unknown");
        expect(out).toContain("🔲 BottomSheet:");
        expect(out).toContain('"Submit"');
        expect(out).toContain("🎯 Root pressables: (none reachable)");
        expect(out).toContain("🚫 Blocked by overlay");
        expect(out).toContain('"Send"');
    });
});
