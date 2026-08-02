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
    /**
     * Points (iOS) / dp (Android) -> delivered-screenshot pixels, the canonical unit
     * every tool reads and writes. Omitted or 1 means "unknown" and leaves coordinates
     * in point space — the pre-unification behaviour, and the safe degradation when a
     * device cannot be measured.
     */
    pixelScale?: number;
}

/**
 * API image cap. A capture wider or taller than this is downscaled before delivery, so
 * it is part of the coordinate contract, not just a transport detail: the pixels an
 * agent reads off the returned image are post-downscale.
 */
export const SCREENSHOT_MAX_DIMENSION = 2000;

/**
 * Downscale a capture of these *device-pixel* dimensions will receive on delivery.
 * Mirrors the resize in `iosScreenshot`/`androidScreenshot`; both derive their own
 * factor the same way, and this is the copy the layout tools predict it with.
 */
export function computeDeliveredDownscale(pixelWidth: number, pixelHeight: number): number {
    const longest = Math.max(pixelWidth, pixelHeight);
    if (!(longest > SCREENSHOT_MAX_DIMENSION)) return 1;
    return longest / SCREENSHOT_MAX_DIMENSION;
}

/**
 * points/dp -> delivered-screenshot pixels, given the device's scale (iOS DPR, Android
 * density/160) and its point/dp screen size.
 *
 * Note this collapses to `SCREENSHOT_MAX_DIMENSION / longestPointDimension` whenever the
 * raw capture overflows the cap — the device scale cancels out — which is why the factor
 * is stable per device rather than per capture.
 */
export function computePixelScale(
    deviceScale: number,
    pointWidth: number,
    pointHeight: number
): number {
    if (!(deviceScale > 0) || !(pointWidth > 0) || !(pointHeight > 0)) return 1;
    const downscale = computeDeliveredDownscale(pointWidth * deviceScale, pointHeight * deviceScale);
    return deviceScale / downscale;
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
export const SCREEN_SPACE_HELPER_JS = [
    `var toScreenSpaceY = ${toScreenSpaceY.toString()};`,
    `var scaleOf = ${scaleOf.toString()};`,
    `var toDeliveredPxY = ${toDeliveredPxY.toString()};`,
    `var toDeliveredPxX = ${toDeliveredPxX.toString()};`,
    `var toDeliveredPxLength = ${toDeliveredPxLength.toString()};`
].join("\n");

/** Scale factor to apply, with the "unknown -> stay in points" default made explicit. */
function scaleOf(m: ScreenSpaceMetrics): number {
    return m.pixelScale && m.pixelScale > 0 ? m.pixelScale : 1;
}

/**
 * A warning line when the device scale could not be resolved, or "" when it could.
 *
 * Without this the degradation is silent and dangerous in one specific way: the tools
 * emit point-space coordinates while tap() still expects delivered pixels, which is the
 * original defect wearing a different hat. Saying so lets the caller fall back to
 * screenshot coordinates instead of tapping the wrong place.
 */
export function unresolvedScaleNote(m: ScreenSpaceMetrics): string {
    if (m.pixelScale && m.pixelScale > 0) return "";
    const unit = m.platform === "android" ? "dp" : "points";
    return (
        `⚠️ Coordinates below are in ${unit}, NOT the usual delivered-pixel space — the ` +
        `device scale could not be read. Do not pass them to tap(); take coordinates from ` +
        `ios_screenshot / android_screenshot instead, or reconnect the device and retry.`
    );
}

/**
 * Fiber-space y (points/dp) -> canonical delivered-screenshot pixels.
 *
 * Order matters: `topInset` is a point-space quantity, so the inset shift has to happen
 * before the scale, not after.
 */
export function toDeliveredPxY(y: number, m: ScreenSpaceMetrics): number {
    return toScreenSpaceY(y, m) * scaleOf(m);
}

/** Fiber-space x -> delivered pixels. No horizontal inset exists on either platform. */
export function toDeliveredPxX(x: number, m: ScreenSpaceMetrics): number {
    return x * scaleOf(m);
}

/** A length (width/height) in points/dp -> delivered pixels. Unaffected by the inset. */
export function toDeliveredPxLength(v: number, m: ScreenSpaceMetrics): number {
    return v * scaleOf(m);
}

/**
 * Delivered pixels -> fiber space. Inverse of {@link toDeliveredPxY}, for tools that
 * take a caller-supplied coordinate (inspect_at_point) and must hit-test against raw
 * `measureInWindow` output.
 */
export function fromDeliveredPxY(y: number, m: ScreenSpaceMetrics): number {
    return fromScreenSpaceY(y / scaleOf(m), m);
}

/** Delivered pixels -> fiber-space x. */
export function fromDeliveredPxX(x: number, m: ScreenSpaceMetrics): number {
    return x / scaleOf(m);
}

interface Box {
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Return a copy of a **screen-space** state with every box in delivered pixels.
 *
 * For consumers that hit-test a caller-supplied coordinate against the state itself
 * rather than just formatting it — the coordinate arrives in delivered pixels, so the
 * geometry has to meet it there. Compose after {@link screenStateToScreenSpace}.
 */
export function screenStateToDeliveredPx<
    T extends {
        pressables: Box[];
        texts: Box[];
        images: Box[];
        overlays: { pressables: Box[]; texts?: Box[]; images?: Box[] }[];
    }
>(ss: T, m: ScreenSpaceMetrics): T {
    const conv = pxScaleConverter(m);
    if (scaleOf(m) === 1) return ss;
    const box = <B extends Box>(b: B): B => {
        const c = conv(b);
        return { ...b, center: c.center, bounds: c.frame };
    };
    return {
        ...ss,
        pressables: ss.pressables.map(box),
        texts: ss.texts.map(box),
        images: ss.images.map(box),
        overlays: ss.overlays.map((o) => ({
            ...o,
            pressables: o.pressables.map(box),
            texts: o.texts ? o.texts.map(box) : o.texts,
            images: o.images ? o.images.map(box) : o.images
        }))
    };
}

/**
 * Converter mapping an item **already in screen space** into canonical delivered pixels.
 *
 * Deliberately pure scale, with no inset term: every caller runs its state through
 * {@link screenStateToScreenSpace} first, so re-applying the shift here would move each
 * coordinate by a second `topInset`. This converter is the single argument that used to
 * differ between the screenshot tools (which passed a real one) and get_screen_state
 * (which passed none and so emitted raw points). Structurally an `ItemCoordConverter`;
 * typed locally to keep this module import-free.
 */
export function pxScaleConverter(m: ScreenSpaceMetrics): (item: Box) => {
    center: { x: number; y: number };
    frame: { x: number; y: number; width: number; height: number };
} {
    const s = scaleOf(m);
    const r = (v: number) => Math.round(v * s);
    return (item) => ({
        center: { x: r(item.center.x), y: r(item.center.y) },
        frame: {
            x: r(item.bounds.x),
            y: r(item.bounds.y),
            width: r(item.bounds.width),
            height: r(item.bounds.height)
        }
    });
}

function shiftBox<T extends Box>(el: T, m: ScreenSpaceMetrics): T {
    return {
        ...el,
        center: { x: el.center.x, y: toScreenSpaceY(el.center.y, m) },
        bounds: { ...el.bounds, y: toScreenSpaceY(el.bounds.y, m) }
    };
}

/**
 * Return a copy of a screen state with every y in screen space.
 *
 * Only y moves — no horizontal inset exists on either platform — and height is untouched,
 * because the shift translates a box rather than resizing it.
 */
export function screenStateToScreenSpace<
    T extends {
        pressables: Box[];
        texts: Box[];
        images: Box[];
        overlays: { pressables: Box[]; texts?: Box[]; images?: Box[] }[];
    }
>(ss: T, m: ScreenSpaceMetrics): T {
    if (!m.topInset || m.topInset <= 0) return ss;
    return {
        ...ss,
        pressables: ss.pressables.map((p) => shiftBox(p, m)),
        texts: ss.texts.map((t) => shiftBox(t, m)),
        images: ss.images.map((i) => shiftBox(i, m)),
        overlays: ss.overlays.map((o) => ({
            ...o,
            pressables: o.pressables.map((p) => shiftBox(p, m)),
            texts: o.texts ? o.texts.map((t) => shiftBox(t, m)) : o.texts,
            images: o.images ? o.images.map((i) => shiftBox(i, m)) : o.images
        }))
    };
}
