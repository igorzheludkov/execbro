import type { ExecutionResult } from "./types.js";
import { executeInApp, delay } from "./jsExecute.js";

// ============================================================================
// Types matching the spec response shape
// ============================================================================

export interface ScreenStatePressable {
    label: string | null;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    testID: string | null;
}

export interface ScreenStateOverlay {
    type: "BottomSheet" | "Modal" | "Alert" | "ActionSheet" | "Unknown";
    title: string | null;
    pressables: ScreenStatePressable[];
}

export interface ScreenStateRoute {
    name: string;
    params: Record<string, unknown> | null;
    stackDepth: number;
}

export interface ScreenState {
    route: ScreenStateRoute | null;
    overlays: ScreenStateOverlay[];
    pressables: ScreenStatePressable[];
}

// ============================================================================
// Pure helpers (exported for unit tests)
// ============================================================================

export function filterPressablesCoveredByOverlay(
    pressables: ScreenStatePressable[],
    overlayBounds: { x: number; y: number; width: number; height: number }
): ScreenStatePressable[] {
    return pressables.filter((p) => {
        const b = p.bounds;
        const fullyCovered =
            b.x >= overlayBounds.x &&
            b.y >= overlayBounds.y &&
            b.x + b.width <= overlayBounds.x + overlayBounds.width &&
            b.y + b.height <= overlayBounds.y + overlayBounds.height;
        return !fullyCovered;
    });
}

export function parseScreenStateResponse(raw: unknown): ScreenState | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.error) return null;
    return {
        route: (r.route as ScreenStateRoute | null) ?? null,
        overlays: (r.overlays as ScreenStateOverlay[]) ?? [],
        pressables: (r.pressables as ScreenStatePressable[]) ?? [],
    };
}

// ============================================================================
// Main function (placeholder — implemented in Task 3/4)
// ============================================================================

export async function getScreenState(
    options: { device?: string } = {}
): Promise<ExecutionResult & { screenState?: ScreenState }> {
    return { success: false, error: "not implemented" };
}
