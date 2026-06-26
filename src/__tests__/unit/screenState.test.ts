import { describe, it, expect } from "@jest/globals";
import {
    markPressablesCoveredByOverlay,
    parseScreenStateResponse,
    formatScreenStateSummary,
    describePressHandler,
    describePropHandlers,
    applyIconHintToLabel,
    formatTextEntry,
    formatImageEntry,
    type ScreenState,
    type ScreenStatePressable,
} from "../../core/screenState.js";

describe("formatScreenStateSummary nativeOverlay", () => {
    function emptyState(over: Partial<ScreenState> = {}): ScreenState {
        return { route: null, overlays: [], pressables: [], texts: [], images: [], ...over };
    }

    it("renders a native-sheet warning line when nativeOverlay is set", () => {
        const out = formatScreenStateSummary(
            emptyState({ nativeOverlay: { kind: "sheet", component: "TrueSheet", note: "x" } })
        );
        expect(out).toContain("Native sheet detected");
        expect(out).toContain("TrueSheet");
    });

    it("renders notes lines", () => {
        const out = formatScreenStateSummary(emptyState({ notes: ["heads up"] }));
        expect(out).toContain("heads up");
    });

    it("omits the warning when nativeOverlay is absent", () => {
        const out = formatScreenStateSummary(emptyState());
        expect(out).not.toContain("Native sheet detected");
    });

    it("groups blocked pressables under Blocked when a native sheet is open", () => {
        const blocked = pressable({ label: "Submit", blockedByOverlay: true });
        const out = formatScreenStateSummary(
            emptyState({ nativeOverlay: { kind: "sheet", component: "TrueSheet", note: "x" }, pressables: [blocked] })
        );
        expect(out).toContain("🚫 Blocked by overlay");
        expect(out).toContain("Submit");
    });
});

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

describe("formatTextEntry", () => {
    const t = (text: string) => ({ text, center: { x: 100, y: 50 }, bounds: { x: 80, y: 40, width: 200, height: 20 } });

    it("renders coordinates, emoji tag, quoted text, and frame", () => {
        expect(formatTextEntry(t("Valya product"), undefined, {})).toBe(
            '  (100, 50) 📝 "Valya product" frame:(80,40 200x20)'
        );
    });

    it("truncates to 80 chars with an ellipsis by default", () => {
        const long = "x".repeat(100);
        const out = formatTextEntry(t(long), undefined, {});
        expect(out).toContain('"' + "x".repeat(80) + '…"');
    });

    it("emits the full string when fullText is set", () => {
        const long = "x".repeat(100);
        const out = formatTextEntry(t(long), undefined, { fullText: true });
        expect(out).toContain('"' + "x".repeat(100) + '"');
        expect(out).not.toContain("…");
    });
});

describe("formatImageEntry", () => {
    const img = (over = {}) => ({ center: { x: 210, y: 175 }, bounds: { x: 0, y: 0, width: 420, height: 350 }, ...over });

    it("renders size, truncated src (60 chars), alt, and frame", () => {
        const longSrc = "https://x/" + "a".repeat(70); // 80 chars → truncates to 60 + …
        expect(formatImageEntry({ ...img(), src: longSrc, alt: "Valya" }, undefined)).toBe(
            '  (210, 175) 🖼 Image 420x350 src="https://x/' + "a".repeat(50) + '…" alt="Valya" frame:(0,0 420x350)'
        );
    });

    it("leaves a short src untouched", () => {
        expect(formatImageEntry({ ...img(), src: "https://x/y.jpg" }, undefined)).toContain('src="https://x/y.jpg"');
    });

    it("omits src when absent and alt when absent", () => {
        expect(formatImageEntry(img(), undefined)).toBe(
            '  (210, 175) 🖼 Image 420x350 frame:(0,0 420x350)'
        );
    });

    it("shows asset ids verbatim (already short)", () => {
        const out = formatImageEntry({ ...img(), src: "asset#42" }, undefined);
        expect(out).toContain('src="asset#42"');
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
        expect(out).toContain('(210, 838) 🔘 <Button /> "Send" frame:(20,810 380x56)');
        expect(out).toContain('near "Skip verification."');
    });

    it("applies the coordinate converter to centers and frames", () => {
        const out = formatScreenStateSummary(state, (p) => ({
            center: { x: p.center.x * 2, y: p.center.y * 2 },
            frame: { x: p.bounds.x * 2, y: p.bounds.y * 2, width: p.bounds.width * 2, height: p.bounds.height * 2 },
        }));
        expect(out).toContain('(420, 1676) 🔘 <Button /> "Send" frame:(40,1620 760x112)');
    });

    it("groups overlay pressables and lists blocked root pressables separately", () => {
        const withOverlay: ScreenState = {
            route: null,
            overlays: [{ type: "BottomSheet", title: null, pressables: [pressable({ label: "Submit" })] }],
            pressables: [pressable({ label: "Send", blockedByOverlay: true })],
            texts: [],
            images: [],
        };
        const out = formatScreenStateSummary(withOverlay, undefined, { pressablesOnly: true });
        expect(out).toContain("📍 Currently focused screen: unknown");
        expect(out).toContain("🔲 BottomSheet:");
        expect(out).toContain('"Submit"');
        expect(out).toContain("🎯 Root pressables: (none reachable)");
        expect(out).toContain("🚫 Blocked by overlay");
        expect(out).toContain('"Send"');
    });
});

describe("formatScreenStateSummary — merged content", () => {
    const base: ScreenState = {
        route: { name: "Detail", params: null, stack: ["Detail"] },
        overlays: [],
        pressables: [
            pressable({ label: "In cart", center: { x: 210, y: 838 }, bounds: { x: 20, y: 810, width: 380, height: 56 } }),
        ],
        texts: [
            { text: "Valya product", center: { x: 146, y: 394 }, bounds: { x: 20, y: 382, width: 251, height: 24 } },
        ],
        images: [
            { src: "https://x/tiger.jpg", alt: null, center: { x: 210, y: 175 }, bounds: { x: 0, y: 0, width: 420, height: 350 } },
        ],
    };

    it("merges text, image, and pressable lines ordered top-to-bottom", () => {
        const out = formatScreenStateSummary(base);
        const idxImg = out.indexOf("🖼 Image");
        const idxText = out.indexOf('📝 "Valya product"');
        const idxPress = out.indexOf('"In cart"');
        expect(idxImg).toBeGreaterThan(-1);
        expect(idxImg).toBeLessThan(idxText);   // image y=175 < text y=394
        expect(idxText).toBeLessThan(idxPress); // text y=394 < pressable y=838
    });

    it("pressablesOnly omits text and image lines", () => {
        const out = formatScreenStateSummary(base, undefined, { pressablesOnly: true });
        expect(out).not.toContain("📝");
        expect(out).not.toContain("🖼");
        expect(out).toContain('"In cart"');
    });

    it("uses a content-accurate header (not 'Pressables') when text/images are included", () => {
        const out = formatScreenStateSummary(base);
        expect(out).toContain("🎯 On screen:");
        expect(out).not.toContain("🎯 Pressables:");
    });

    it("keeps the legacy 'Pressables' header under pressablesOnly", () => {
        const out = formatScreenStateSummary(base, undefined, { pressablesOnly: true });
        expect(out).toContain("🎯 Pressables:");
        expect(out).not.toContain("🎯 On screen:");
    });

    it("marks pressables with 🔘 in the enriched view so tap targets stand out", () => {
        const out = formatScreenStateSummary(base);
        expect(out).toContain('🔘 "In cart"');
    });

    it("omits the 🔘 marker under pressablesOnly (byte-compatible legacy lines)", () => {
        const out = formatScreenStateSummary(base, undefined, { pressablesOnly: true });
        expect(out).not.toContain("🔘");
        expect(out).toContain('(210, 838) "In cart"');
    });

    it("labels the reachable root group as content, not 'Root pressables', when enriched", () => {
        const ss: ScreenState = {
            route: null,
            overlays: [{ type: "BottomSheet", title: "Sheet", pressables: [pressable({ label: "OK" })], texts: [], images: [] }],
            pressables: [pressable({ label: "Back", blockedByOverlay: true, center: { x: 40, y: 100 }, bounds: { x: 16, y: 76, width: 48, height: 48 } })],
            texts: [{ text: "Heading", center: { x: 100, y: 200 }, bounds: { x: 0, y: 190, width: 200, height: 20 } }],
            images: [],
        };
        const out = formatScreenStateSummary(ss);
        expect(out).toContain("🎯 Reachable (outside any overlay):");
        expect(out).not.toContain("🎯 Root pressables:");
    });

    it("does not list a text that duplicates a pressable's nearbyText", () => {
        const ss: ScreenState = {
            ...base,
            pressables: [pressable({ label: "[SvgCartNew — possibly cart button]", nearbyText: "1", center: { x: 380, y: 100 }, bounds: { x: 356, y: 76, width: 48, height: 48 } })],
            texts: [{ text: "1", center: { x: 390, y: 82 }, bounds: { x: 384, y: 80, width: 16, height: 16 } }],
        };
        const out = formatScreenStateSummary(ss);
        expect(out).not.toContain('📝 "1"');
    });

    it("caps texts at 60 with an explicit overflow marker", () => {
        const many = Array.from({ length: 75 }, (_, i) => ({ text: "t" + i, center: { x: 0, y: i }, bounds: { x: 0, y: i, width: 1, height: 1 } }));
        const out = formatScreenStateSummary({ ...base, texts: many });
        expect(out).toContain("… +15 more text");
    });

    it("places overlay text in the overlay group and blocked text in the Blocked group", () => {
        const ss: ScreenState = {
            route: null,
            overlays: [{ type: "BottomSheet", title: "Sheet", pressables: [], texts: [{ text: "Added to Cart!", center: { x: 210, y: 175 }, bounds: { x: 0, y: 160, width: 420, height: 30 } }], images: [] }],
            pressables: [pressable({ label: "Back", blockedByOverlay: true, center: { x: 40, y: 100 }, bounds: { x: 16, y: 76, width: 48, height: 48 } })],
            texts: [{ text: "Valya product", blockedByOverlay: true, center: { x: 146, y: 394 }, bounds: { x: 20, y: 382, width: 251, height: 24 } }],
            images: [],
        };
        const out = formatScreenStateSummary(ss);
        const idxSheet = out.indexOf("🔲 BottomSheet");
        const idxAdded = out.indexOf('📝 "Added to Cart!"');
        const idxBlocked = out.indexOf("🚫 Blocked");
        const idxValya = out.indexOf('📝 "Valya product"');
        expect(idxSheet).toBeLessThan(idxAdded);
        expect(idxAdded).toBeLessThan(idxBlocked);
        expect(idxBlocked).toBeLessThan(idxValya);
    });
});
