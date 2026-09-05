// Shared transform-composition rule for the fiber-walk tools. Runs both in Node
// (unit-tested) and inside the app's Hermes runtime (via TRANSFORM_COMPOSE_JS), so it must
// stay plain: no optional chaining, no spreads, no closure references.

export interface ComposedTransform {
    /** Offset measureInWindow could not see, to be added to the measured frame. */
    dx: number;
    dy: number;
    /** The frame is displaced by something this does not model exactly. */
    uncertain: boolean;
    /** Short description of the first interesting op, for the ⚠transformed tag. */
    label: string | null;
}

/** The current value of an Animated node, or null when it is not one / cannot be read. */
export function animatedValueOf(v: any): number | null {
    if (!v || typeof v !== "object") return null;
    if (typeof v.__getValue !== "function") return null;
    try {
        var got = v.__getValue();
        return typeof got === "number" && isFinite(got) ? got : null;
    } catch (e) {
        return null;
    }
}

/**
 * An Animated value driven on the native side (`useNativeDriver: true`).
 *
 * This is the whole discriminator for whether a transform has to be composed by hand:
 * a native-driven value is applied straight to the platform view and never reaches the
 * shadow tree, which is what measureInWindow reads.
 */
export function isNativeDriven(v: any): boolean {
    return !!(v && typeof v === "object" && v.__isNative === true);
}

/**
 * Fold one style's `transform` into an offset that measureInWindow is missing.
 *
 * ONLY a native-driven Animated value contributes to dx/dy. Everything else — a static
 * number, a JS-driven Animated value, a value Reanimated wrote — is committed to the
 * shadow tree, so measureInWindow already reports the displaced frame and adding the
 * translation again double-counts it.
 *
 * That over-generalisation is what hid a bottom sheet's contents. Gorhom holds its sheet
 * open with a plain numeric `translateY`, so on the test app's Modals screen the sheet's
 * CLOSE button measured correctly at y=571 in a 912pt viewport. The walk up the ancestors
 * met that translation on both the `View` and the `RCTView` it renders, composed 422 twice
 * to y=1415, and the button was dropped as off-viewport. The sheet listed as containing no
 * pressables at all, with no indication anything had been removed.
 *
 * The rule the original evidence actually supports is narrower: a pinned sticky header sat
 * at y=132pt while measureInWindow reported y=-1698pt, and RN attaches the scroll value
 * driving sticky headers with `attachNativeEvent`. Compose what the shadow tree does not
 * know about, nothing else.
 *
 * Note that a native-driven value reads back stale from JS — measured on device, RN's own
 * sticky header reports `__getValue() === 0` while pinned — so composing it usually adds
 * nothing and the honest answer is the `uncertain` flag, not a corrected frame.
 */
export function composeTransformOps(t: any): ComposedTransform {
    var out: ComposedTransform = { dx: 0, dy: 0, uncertain: false, label: null };
    if (!t) return out;
    if (!Array.isArray(t)) {
        out.uncertain = true;
        out.label = "transform:<opaque>";
        return out;
    }
    for (var i = 0; i < t.length; i++) {
        var op = t[i];
        if (!op || typeof op !== "object") continue;
        for (var key in op) {
            var raw = op[key];
            var val = typeof raw === "number" && isFinite(raw) ? raw : animatedValueOf(raw);
            if (val === null) {
                // An opaque value: not a number and not a readable node.
                out.uncertain = true;
                if (!out.label) out.label = key + ":<unreadable>";
                continue;
            }
            var driven = isNativeDriven(raw);
            if (driven) out.uncertain = true;
            if (key === "translateX" || key === "translateY") {
                if (!driven) continue;
                if (key === "translateX") out.dx += val;
                else out.dy += val;
                if (!out.label && val !== 0) out.label = key + ":" + val;
            } else if (
                val !== 0 &&
                !(key === "scale" && val === 1) &&
                !(key === "scaleX" && val === 1) &&
                !(key === "scaleY" && val === 1)
            ) {
                // scale / rotate / skew / matrix at a non-identity value: a real geometric
                // effect this does not model. Say so rather than presenting the untouched
                // frame as exact.
                out.uncertain = true;
                if (!out.label) out.label = key + ":" + val;
            }
        }
    }
    return out;
}

/** JS source defining the composition helpers for injection into an IIFE expression. */
export const TRANSFORM_COMPOSE_JS = [
    `var animatedValueOf = ${animatedValueOf.toString()};`,
    `var isNativeDriven = ${isNativeDriven.toString()};`,
    `var composeTransformOps = ${composeTransformOps.toString()};`
].join("\n");
