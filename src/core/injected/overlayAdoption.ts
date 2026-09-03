// Shared overlay-adoption rule. Runs both in Node (unit-tested) and inside the app's
// Hermes runtime (via OVERLAY_ADOPTION_JS), so it must stay plain: no optional chaining,
// no spreads, no closure references.

export interface AdoptionRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AdoptionPressable {
    /** Overlay this pressable belongs to by fiber ancestry, or null when it has none. */
    overlayIdx: number | null;
    /** Position in DFS collection order, which is paint order. */
    paintIdx: number;
    bounds: AdoptionRect;
}

export interface AdoptionOverlay {
    hasContent: boolean;
    /** Paint position of the overlay on the same counter as `paintIdx`. */
    enterIdx: number;
    contentBounds: AdoptionRect;
}

/**
 * Should this overlay claim a pressable that fiber ancestry did not give it?
 *
 * Containment exists as a fallback for content an overlay portals out of its own subtree,
 * where ancestry cannot reach it. Geometry alone is not enough to justify that: an
 * overlay's content rect routinely contains parts of the screen *behind* it, and adopting
 * those reports them as the overlay's own contents — that is, as reachable, when they are
 * precisely what the overlay blocks.
 *
 * Paint order is what separates the two. The walk is DFS pre-order over siblings, which is
 * React Native's paint order, so a pressable collected after the overlay is drawn on top
 * of it and can legitimately be its content, while one collected before is behind it. The
 * occlusion test already relies on that ordering for the inverse question.
 *
 * Observed on the test app (2026-09-04): an RN <Modal> holding a single CLOSE button
 * reported the six buttons on the screen underneath as its contents, because its measured
 * content rect contained them. All six were unreachable behind the modal.
 */
export function adoptsByContainment(p: AdoptionPressable, o: AdoptionOverlay): boolean {
    if (p.overlayIdx != null) return false;
    if (!o.hasContent) return false;
    if (!(o.enterIdx >= 0)) return false;
    if (!(p.paintIdx > o.enterIdx)) return false;
    var b = p.bounds;
    var ob = o.contentBounds;
    return b.x >= ob.x && b.y >= ob.y &&
        b.x + b.width <= ob.x + ob.width &&
        b.y + b.height <= ob.y + ob.height;
}

/** JS source defining the adoption rule for injection into an IIFE expression. */
export const OVERLAY_ADOPTION_JS = `var adoptsByContainment = ${adoptsByContainment.toString()};`;
