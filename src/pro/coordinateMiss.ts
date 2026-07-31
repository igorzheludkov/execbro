import type {
    ScreenState,
    ScreenStatePressable,
    ScreenStateText,
} from "../core/screenState.js";

/**
 * Explain why a coordinate tap produced no visual change.
 *
 * Coordinate taps are the second-highest-volume strategy and win 99.6% of the
 * time — "win" only meaning the touch dispatched. ~15% of them change nothing,
 * because the coordinates were estimated from a screenshot and landed in
 * padding, on a label, or on an element sitting behind an open sheet. Until now
 * the agent got "no visual change detected" and nothing else, so its only move
 * was to screenshot and guess again.
 *
 * The screen-state engine already knows what occupies every point and which
 * elements an overlay blocks. This turns that into one actionable sentence.
 */

export interface CoordinateMissTarget {
    label: string | null;
    component?: string | null;
    testID: string | null;
    /** Center in the SAME coordinate space the diagnosis was asked for. */
    center: { x: number; y: number };
    /** Edge distance from the tapped point, in that same space. */
    distance: number;
    /** Where the target sits relative to the tapped point, e.g. "below". */
    direction: string;
    blockedByOverlay?: boolean;
}

export interface CoordinateMissDiagnosis {
    /** What occupied the tapped point, in plain words. */
    hit: string;
    /** Closest element the caller could tap instead. */
    nearest?: CoordinateMissTarget;
    /** True when the point landed on something an overlay covers. */
    blockedByOverlay: boolean;
    /** One-line, agent-facing next step. */
    suggestion: string;
}

function rectDistance(
    point: { x: number; y: number },
    b: { x: number; y: number; width: number; height: number }
): number {
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height));
    return Math.round(Math.sqrt(dx * dx + dy * dy));
}

function contains(
    point: { x: number; y: number },
    b: { x: number; y: number; width: number; height: number }
): boolean {
    return (
        point.x >= b.x &&
        point.x <= b.x + b.width &&
        point.y >= b.y &&
        point.y <= b.y + b.height
    );
}

function describeDirection(
    point: { x: number; y: number },
    center: { x: number; y: number }
): string {
    const dx = center.x - point.x;
    const dy = center.y - point.y;
    if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? "below" : "above";
    return dx >= 0 ? "to the right" : "to the left";
}

function nameOf(p: ScreenStatePressable): string {
    const parts: string[] = [];
    if (p.component) parts.push(`<${p.component} />`);
    const text = p.label || p.nearbyText || p.icon;
    if (text) parts.push(`"${text}"`);
    if (p.testID) parts.push(`testID="${p.testID}"`);
    return parts.length > 0 ? parts.join(" ") : "an unlabelled pressable";
}

/**
 * Flatten root pressables and every overlay's pressables into one list.
 * Overlay members are reachable; root members an overlay covers are not.
 */
export function collectPressables(state: ScreenState): ScreenStatePressable[] {
    const all: ScreenStatePressable[] = [...(state.pressables ?? [])];
    for (const overlay of state.overlays ?? []) {
        all.push(...(overlay.pressables ?? []));
    }
    return all;
}

function collectTexts(state: ScreenState): ScreenStateText[] {
    const all: ScreenStateText[] = [...(state.texts ?? [])];
    for (const overlay of state.overlays ?? []) {
        all.push(...(overlay.texts ?? []));
    }
    return all;
}

/**
 * @param point  the tapped point, in the same space as the screen state's bounds
 * @param toReportSpace  maps a screen-state coordinate into the space the caller
 *   used for its x/y (screenshot pixels), so suggested coordinates are directly
 *   re-tappable without the agent doing any conversion.
 */
export function explainCoordinateMiss(
    point: { x: number; y: number },
    state: ScreenState,
    toReportSpace: (v: number) => number = (v) => v
): CoordinateMissDiagnosis | null {
    const pressables = collectPressables(state);
    const texts = collectTexts(state);
    if (pressables.length === 0 && texts.length === 0) return null;

    const reachable = pressables.filter((p) => !p.blockedByOverlay);

    const toTarget = (p: ScreenStatePressable): CoordinateMissTarget => ({
        label: p.label,
        component: p.component,
        testID: p.testID,
        center: { x: toReportSpace(p.center.x), y: toReportSpace(p.center.y) },
        distance: toReportSpace(rectDistance(point, p.bounds)),
        direction: describeDirection(point, p.center),
        blockedByOverlay: p.blockedByOverlay,
    });

    const nearestReachable = reachable
        .map(toTarget)
        .sort((a, b) => a.distance - b.distance)[0];

    // 1. The point is inside a REACHABLE pressable — the coordinates were right,
    //    so the handler is the suspect, not the aim. Checked before the blocked
    //    case because an overlay button and the element it covers can share a
    //    point; the touch goes to the overlay, so that is what we must report.
    const pressableHit = reachable.find((p) => contains(point, p.bounds));
    if (pressableHit) {
        return {
            hit: nameOf(pressableHit),
            blockedByOverlay: false,
            suggestion: `The tap landed inside ${nameOf(pressableHit)}, so the coordinates were correct — the press produced no visual change. Check the element's onPress handler, or use burst=true if the feedback is transient.`,
        };
    }

    // 2. The point is inside a pressable that an overlay covers — the single
    //    most misleading case, because the pixels are visible on screen.
    const blockedHit = pressables.find((p) => p.blockedByOverlay && contains(point, p.bounds));
    if (blockedHit) {
        const overlayType = state.overlays?.[0]?.type ?? "overlay";
        return {
            hit: `${nameOf(blockedHit)} — covered by an open ${overlayType}`,
            nearest: nearestReachable,
            blockedByOverlay: true,
            suggestion: nearestReachable
                ? `That element is behind an open ${overlayType} and cannot receive taps. Dismiss the ${overlayType} first, or tap ${nameOf2(nearestReachable)} at (${nearestReachable.center.x}, ${nearestReachable.center.y}).`
                : `That element is behind an open ${overlayType} and cannot receive taps. Dismiss the ${overlayType} first.`,
        };
    }

    // 3. The point is on text or empty space — the aim missed.
    const textHit = texts.find((t) => contains(point, t.bounds));
    const hit = textHit
        ? `text "${textHit.text.slice(0, 60)}"`
        : "no element (empty space)";

    return {
        hit,
        nearest: nearestReachable,
        blockedByOverlay: false,
        suggestion: nearestReachable
            ? `Nothing pressable at that point — it hit ${hit}. Nearest tappable element is ${nameOf2(nearestReachable)} at (${nearestReachable.center.x}, ${nearestReachable.center.y}), ${nearestReachable.distance}px ${nearestReachable.direction}. Prefer tap(testID=) / tap(text=) over estimating coordinates from a screenshot.`
            : `Nothing pressable at that point — it hit ${hit}, and no reachable pressable was found on screen.`,
    };
}

function nameOf2(t: CoordinateMissTarget): string {
    const parts: string[] = [];
    if (t.component) parts.push(`<${t.component} />`);
    if (t.label) parts.push(`"${t.label}"`);
    if (t.testID) parts.push(`testID="${t.testID}"`);
    return parts.length > 0 ? parts.join(" ") : "an unlabelled pressable";
}
