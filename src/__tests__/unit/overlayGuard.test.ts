import { decideOverlayBlock } from "../../pro/overlayGuard.js";
import type { ScreenState, ScreenStatePressable } from "../../core/screenState.js";

function pressable(p: Partial<ScreenStatePressable> & {
    x: number; y: number; w: number; h: number;
}): ScreenStatePressable {
    return {
        label: p.label ?? null,
        component: p.component ?? null,
        testID: p.testID ?? null,
        center: { x: p.x + p.w / 2, y: p.y + p.h / 2 },
        bounds: { x: p.x, y: p.y, width: p.w, height: p.h },
        blockedByOverlay: p.blockedByOverlay,
        nearbyText: p.nearbyText ?? null
    };
}

/**
 * The reported scenario, in the canonical delivered-pixel space: a sheet covering the
 * bottom of the screen, the tab bar behind it, and reachable content above it.
 */
function sheetOverTabBar(): ScreenState {
    return {
        route: null,
        overlays: [
            {
                type: "Unknown",
                title: "Events 40 captured",
                pressables: [
                    pressable({ x: 29, y: 1454, w: 276, h: 66, label: "1 Storage 31", component: "TouchableOpacity" })
                ]
            }
        ],
        pressables: [
            pressable({ x: 44, y: 884, w: 206, h: 94, label: "Submit", testID: "submit-btn", component: "Pressable" }),
            pressable({
                x: 230, y: 1818, w: 230, h: 107,
                label: "State, tab, 2 of 4", component: "BottomTabItem", blockedByOverlay: true
            }),
            pressable({
                x: 44, y: 1388, w: 833, h: 99,
                label: "No testID", component: "InternalTextInput", blockedByOverlay: true
            })
        ],
        texts: [],
        images: []
    };
}

describe("decideOverlayBlock", () => {
    it("returns null when no overlay is on screen", () => {
        const ss = sheetOverTabBar();
        ss.overlays = [];
        expect(decideOverlayBlock(ss, { x: 346, y: 1873 })).toBeNull();
    });

    it("returns null when nothing is flagged blocked", () => {
        const ss = sheetOverTabBar();
        ss.pressables = ss.pressables.map((p) => ({ ...p, blockedByOverlay: false }));
        expect(decideOverlayBlock(ss, { x: 346, y: 1873 })).toBeNull();
    });

    it("refuses the reported case: coordinates on a tab covered by the sheet", () => {
        const v = decideOverlayBlock(sheetOverTabBar(), { x: 346, y: 1873 });
        expect(v).not.toBeNull();
        expect(v!.kind).toBe("blocked");
        expect((v as any).element).toContain("BottomTabItem");
        expect((v as any).element).toContain("State, tab, 2 of 4");
        expect(v!.overlay).toContain("Events 40 captured");
    });

    it("allows coordinates on a reachable element above the overlay", () => {
        expect(decideOverlayBlock(sheetOverTabBar(), { x: 147, y: 932 })).toBeNull();
    });

    it("allows coordinates on empty space", () => {
        expect(decideOverlayBlock(sheetOverTabBar(), { x: 5, y: 5 })).toBeNull();
    });

    // Regression: the overlay's own controls live under ss.overlays, not ss.pressables.
    // Ignoring them made a tap on the sheet resolve to the covered input behind it.
    it("allows a tap on the overlay's own control that overlaps a covered element", () => {
        const ss = sheetOverTabBar();
        // Storage chip (29,1454 276x66) overlaps the blocked input (44,1388 833x99), so
        // this reports as shadowed. The point of the test is that it is NOT refused —
        // the chip is a real, reachable control and the tap must still be dispatched.
        expect(decideOverlayBlock(ss, { x: 167, y: 1487 })?.kind).not.toBe("blocked");
    });

    // The sheet's own row can sit exactly over a covered element. Dispatching is right —
    // the OS delivers to the row — but the caller aiming at the tab must be told so.
    it("reports a shadowed hit when an overlay control sits over a covered element", () => {
        const ss = sheetOverTabBar();
        ss.overlays[0].pressables.push(
            pressable({ x: 2, y: 1776, w: 917, h: 143, label: "/Native ROUTE", component: "UnifiedEventItem" })
        );
        const v = decideOverlayBlock(ss, { x: 346, y: 1873 });
        expect(v).not.toBeNull();
        expect(v!.kind).toBe("shadowed");
        expect((v as any).hit).toContain("UnifiedEventItem");
        expect((v as any).covered).toContain("State, tab, 2 of 4");
    });

    it("stays silent when an overlay control covers no blocked element", () => {
        const ss = sheetOverTabBar();
        // The Storage chip overlaps the blocked input, so use a point on the chip that
        // the input does not reach: the input spans x 44..877, the chip x 29..305.
        expect(decideOverlayBlock(ss, { x: 35, y: 1487 })).toBeNull();
    });

    it("refuses a named target that is covered", () => {
        const v = decideOverlayBlock(sheetOverTabBar(), { text: "State, tab, 2 of 4" });
        expect(v).not.toBeNull();
        expect((v as any).element).toContain("State, tab, 2 of 4");
    });

    it("allows a named target that is reachable", () => {
        expect(decideOverlayBlock(sheetOverTabBar(), { testID: "submit-btn" })).toBeNull();
    });

    // Regression: matching used to be a priority chain, so an unmatched testID short-
    // circuited the check and let a covered text target through to dispatch.
    it("refuses when a non-matching testID accompanies a covered text", () => {
        const v = decideOverlayBlock(sheetOverTabBar(), {
            testID: "does-not-exist",
            text: "State, tab, 2 of 4"
        });
        expect(v).not.toBeNull();
        expect((v as any).element).toContain("BottomTabItem");
    });

    it("allows a name that also matches a reachable element elsewhere", () => {
        const ss = sheetOverTabBar();
        ss.pressables.push(pressable({ x: 44, y: 300, w: 100, h: 40, label: "State, tab, 2 of 4" }));
        expect(decideOverlayBlock(ss, { text: "State, tab, 2 of 4" })).toBeNull();
    });

    // Safety valve: a fullCover misclassification marks every root pressable blocked. If
    // the overlay also exposes no controls, refusing would kill every tap in the app.
    it("declines to judge when the model says nothing at all is reachable", () => {
        const ss = sheetOverTabBar();
        ss.pressables = ss.pressables.map((p) => ({ ...p, blockedByOverlay: true }));
        ss.overlays = [{ type: "Modal", title: null, pressables: [] }];
        expect(decideOverlayBlock(ss, { x: 346, y: 1873 })).toBeNull();
        expect(decideOverlayBlock(ss, { testID: "submit-btn" })).toBeNull();
    });

    it("does not leak the internal 'Unknown' bucket name into the message", () => {
        const v = decideOverlayBlock(sheetOverTabBar(), { x: 346, y: 1873 });
        expect(v!.overlay).not.toContain("Unknown");
    });

    it("picks the innermost element when covered boxes overlap", () => {
        const ss = sheetOverTabBar();
        ss.pressables.push(pressable({
            x: 0, y: 1800, w: 921, h: 200, label: "outer row", blockedByOverlay: true
        }));
        const v = decideOverlayBlock(ss, { x: 346, y: 1873 });
        expect((v as any).element).toContain("State, tab, 2 of 4");
    });
});
