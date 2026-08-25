/**
 * Correction for react-native-screens' modally-presented screens.
 *
 * A `<Stack.Screen options={{presentation:'modal'}}>` is handed to UIKit, which
 * presents it as a sheet inset from the top of the window. RN's layout system
 * never sees that inset: the shadow tree lays the screen out at (0,0) in its own
 * space, so `measureInWindow` — and `measure`, and `measureLayout` against the
 * root — all report a y that is short by the inset. Measured on device
 * (RN 0.83 / Fabric, iPhone Air): a switch whose pixels sit at y=443.7pt reports
 * y=375.7pt, exactly 68pt high, while x matches to the point.
 *
 * Every coordinate on such a screen is wrong by that one number, so a tap aimed
 * with a reported frame lands a row or two above what the agent meant — which is
 * indistinguishable from a correct tap in a pixel diff.
 *
 * The inset is recoverable without any native help. A UIKit sheet is
 * bottom-anchored and full-width, so its top edge sits at
 * `viewportHeight - sheetHeight`, and the sheet's own host measures its real
 * size (844 of a 912pt window here). That also makes the correction self-
 * cancelling: a full-screen presentation measures the full height and yields 0,
 * and a platform that already reports absolute coordinates yields 0 because the
 * sheet's own `y` is then non-zero.
 */

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Vertical correction for content inside a presented sheet, in points.
 *
 * `boundary` is the sheet host's own measurement. Returns 0 whenever the
 * geometry does not match a bottom-anchored, full-width sheet — an iPad form
 * sheet is centred rather than bottom-anchored, and guessing its offset would
 * replace a known error with an invented one.
 */
export function sheetShiftY(
    boundary: Rect | null | undefined,
    viewport: { width: number; height: number } | null | undefined
): number {
    if (!boundary || !viewport) return 0;
    if (!(boundary.width > 0) || !(boundary.height > 0)) return 0;
    if (!(viewport.width > 0) || !(viewport.height > 0)) return 0;
    // Full-width only. A narrower sheet is centred, not bottom-anchored.
    if (Math.abs(boundary.width - viewport.width) > 2) return 0;
    const dy = viewport.height - (boundary.y + boundary.height);
    // Sub-pixel noise is not an inset, and a negative result means the sheet is
    // taller than the viewport — neither is a correction worth applying.
    return dy > 1 ? dy : 0;
}

/**
 * Host component names that mark the boundary where UIKit takes over layout.
 * `RNSModalScreen` is what current react-native-screens emits for a modal
 * presentation; older versions reuse `RNSScreen` and carry the presentation in
 * a prop, which `SHEET_HELPERS_JS` checks too.
 */
export const MODAL_SCREEN_HOST = "RNSModalScreen";

/**
 * Injected source. The walkers run inside Hermes and cannot import, so the
 * boundary search and the shift live here as one definition rather than a copy
 * per walker — divergence between copies is exactly what put two coordinate
 * spaces in this codebase before.
 */
export const SHEET_HELPERS_JS = [
    `var sheetShiftY = ${sheetShiftY.toString()};`,
    `function modalBoundaryOf(fiber) {
        var cur = fiber, d = 0;
        while (cur && d < 500) {
            var t = cur.type;
            if (typeof t === 'string') {
                if (t === '${MODAL_SCREEN_HOST}') return cur;
                if (t === 'RNSScreen') {
                    var sp = (cur.memoizedProps || {}).stackPresentation;
                    if (sp && sp !== 'push') return cur;
                }
            }
            cur = cur.return;
            d++;
        }
        return null;
    }`,
    `function shiftRect(m, dy) {
        if (!m || !dy) return m;
        return { x: m.x, y: m.y + dy, width: m.width, height: m.height };
    }`
].join("\n");
