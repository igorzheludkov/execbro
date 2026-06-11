import { describe, it, expect } from "@jest/globals";
import {
    filterPressablesCoveredByOverlay,
    parseScreenStateResponse,
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

describe("filterPressablesCoveredByOverlay", () => {
    const overlay = { x: 0, y: 400, width: 375, height: 300 };

    it("keeps pressable fully above the overlay", () => {
        const p = pressable({ bounds: { x: 10, y: 50, width: 100, height: 44 } });
        const result = filterPressablesCoveredByOverlay([p], overlay);
        expect(result).toHaveLength(1);
    });

    it("removes pressable fully inside the overlay bounds", () => {
        const p = pressable({ bounds: { x: 50, y: 450, width: 100, height: 44 } });
        const result = filterPressablesCoveredByOverlay([p], overlay);
        expect(result).toHaveLength(0);
    });

    it("keeps pressable that partially overlaps (only fully covered ones are removed)", () => {
        const p = pressable({ bounds: { x: 50, y: 380, width: 100, height: 60 } });
        const result = filterPressablesCoveredByOverlay([p], overlay);
        expect(result).toHaveLength(1);
    });

    it("handles empty pressables list", () => {
        expect(filterPressablesCoveredByOverlay([], overlay)).toHaveLength(0);
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
            route: { name: "ProductDetails", params: { productId: "123" }, stackDepth: 2 },
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
        expect(result!.route!.stackDepth).toBe(2);
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
});
