import { describe, it, expect } from "@jest/globals";
import {
    isHiddenNavigationScene,
    VISIBILITY_HELPERS_JS,
    detectNativeSheet,
    NATIVE_SHEET_MARKER_RE_SRC,
} from "../../core/injected/visibility.js";

describe("isHiddenNavigationScene", () => {
    it("prunes an unfocused react-navigation Screen destination (Drawer/Tab)", () => {
        expect(isHiddenNavigationScene("Screen", { focused: false, route: { name: "Tabs" } })).toBe(true);
    });

    it("keeps a focused react-navigation Screen destination", () => {
        expect(isHiddenNavigationScene("Screen", { focused: true, route: { name: "Native" } })).toBe(false);
    });

    it("does NOT prune a warm rn-screens Screen with activityState 2 (no route)", () => {
        expect(isHiddenNavigationScene("Screen", { activityState: 2 })).toBe(false);
    });

    it("prunes a react-native-screens Screen with activityState 0", () => {
        expect(isHiddenNavigationScene("Screen", { activityState: 0 })).toBe(true);
    });

    it("prunes RNSScreen with activityState 0", () => {
        expect(isHiddenNavigationScene("RNSScreen", { activityState: 0 })).toBe(true);
    });

    it("prunes legacy MaybeScreen with active 0", () => {
        expect(isHiddenNavigationScene("MaybeScreen", { active: 0 })).toBe(true);
    });

    it("keeps an unfocused SceneView native-stack scene unchanged (existing behavior)", () => {
        expect(isHiddenNavigationScene("SceneView", { focused: false })).toBe(true);
    });

    it("prunes display:none (object and array style)", () => {
        expect(isHiddenNavigationScene("View", { style: { display: "none" } })).toBe(true);
        expect(isHiddenNavigationScene("View", { style: [{ flex: 1 }, { display: "none" }] })).toBe(true);
    });

    it("returns false for a plain visible view", () => {
        expect(isHiddenNavigationScene("View", { style: { flex: 1 } })).toBe(false);
        expect(isHiddenNavigationScene("View", null)).toBe(false);
    });
});

describe("VISIBILITY_HELPERS_JS parity", () => {
    // The injected source must behave identically to the TS function (single source of truth).
    const injected = new Function(`${VISIBILITY_HELPERS_JS}; return isHiddenNavigationScene;`)() as (
        name: string | null,
        props: any
    ) => boolean;

    const cases: Array<[string | null, any]> = [
        ["Screen", { focused: false, route: { name: "Tabs" } }],
        ["Screen", { focused: true, route: { name: "Native" } }],
        ["Screen", { activityState: 0 }],
        ["Screen", { activityState: 2 }],
        ["RNSScreen", { activityState: 0 }],
        ["MaybeScreen", { active: 0 }],
        ["SceneView", { focused: false }],
        ["View", { style: { display: "none" } }],
        ["View", { style: [{ flex: 1 }, { display: "none" }] }],
        ["View", { style: { flex: 1 } }],
        ["View", null],
    ];

    it("emits no tsc helper artifacts", () => {
        expect(VISIBILITY_HELPERS_JS).toContain("isHiddenNavigationScene");
        expect(VISIBILITY_HELPERS_JS).not.toContain("__assign");
        expect(VISIBILITY_HELPERS_JS).not.toContain("tslib");
    });

    it.each(cases)("matches TS impl for (%s, %o)", (name, props) => {
        expect(injected(name, props)).toBe(isHiddenNavigationScene(name, props));
    });
});

describe("detectNativeSheet", () => {
    it("detects True Sheet from open markers", () => {
        expect(detectNativeSheet(["View", "TrueSheetContentView"])).toEqual({ kind: "sheet", component: "TrueSheet" });
    });

    it("returns null when only the closed wrapper is present", () => {
        expect(detectNativeSheet(["TrueSheet", "TrueSheetView"])).toBeNull();
    });

    it("returns null for an empty marker set", () => {
        expect(detectNativeSheet([])).toBeNull();
    });
});

describe("NATIVE_SHEET_MARKER_RE_SRC", () => {
    it("matches the open markers and not the closed wrappers", () => {
        const re = new RegExp(`^(${NATIVE_SHEET_MARKER_RE_SRC})$`);
        expect(re.test("TrueSheetContainerView")).toBe(true);
        expect(re.test("TrueSheetContentView")).toBe(true);
        expect(re.test("TrueSheetView")).toBe(false);
    });
});
