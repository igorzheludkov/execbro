/**
 * One coordinate space for every layout tool: **screen space**.
 *
 * `measureInWindow` does not report screen coordinates uniformly:
 *
 * - **Android** returns coordinates relative to the app window, which starts *below*
 *   the status bar. A header button measured at y=7dp sits at y=61dp on screen.
 * - **iOS** returns coordinates that already include the status bar — except for
 *   react-native-screens modal-presented screens, which measure from the modal's own
 *   presentation container. A modal header button measured at y=29pt sits at y=88pt on
 *   screen, exactly one safe-area inset lower.
 *
 * The screenshot formatters already compensated for both, which is why screenshot pixel
 * coordinates were correct. The point-space outputs (`get_screen_state`,
 * `inspect_at_point`) did not, so the two families disagreed whenever a modal was open:
 * converting a screenshot pixel coordinate to points by dividing by the pixel ratio — the
 * documented procedure — landed an inset off and resolved to the screen underneath.
 *
 * Everything now normalises through here, so a coordinate read from any tool can be
 * passed to any other tool.
 */

export interface ScreenSpaceMetrics {
    platform: "ios" | "android";
    /** iOS: safe-area top in points. Android: status bar height in dp. 0 disables shifting. */
    topInset: number;
}

/**
 * Fiber-space y -> screen-space y.
 *
 * The iOS rule is a heuristic: nothing in the fiber tree says "I am inside a modal
 * presentation", and the inset is only knowable natively. An element measuring *above*
 * the safe-area top is the signal — on a normal screen that band is occupied by the
 * status bar and holds no app content. This is the same rule the screenshot formatters
 * already shipped; it is centralised here rather than made more clever, so the pixel
 * output that users have been reading stays byte-identical.
 */
export function toScreenSpaceY(y: number, m: ScreenSpaceMetrics): number {
    if (!m.topInset || m.topInset <= 0) return y;
    if (m.platform === "android") return y + m.topInset;
    return y < m.topInset ? y + m.topInset : y;
}

/** Screen-space y -> fiber-space y. Inverse of {@link toScreenSpaceY}. */
export function fromScreenSpaceY(y: number, m: ScreenSpaceMetrics): number {
    if (!m.topInset || m.topInset <= 0) return y;
    if (m.platform === "android") return y - m.topInset;
    // Mirror of the forward rule: only values that could have been shifted are unshifted.
    // A y in [topInset, 2*topInset) is the image of [0, topInset) under the forward map.
    return y >= m.topInset && y < m.topInset * 2 ? y - m.topInset : y;
}

/**
 * Source for the injected walkers, which run inside Hermes and cannot import.
 * Emitted as a plain function so the in-app hit-test normalises measurements the same
 * way the Node side does — a second copy of this rule is exactly what caused the drift.
 */
export const SCREEN_SPACE_HELPER_JS = `var toScreenSpaceY = ${toScreenSpaceY.toString()};`;
