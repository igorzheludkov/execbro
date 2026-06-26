// Shared visibility logic for every fiber-walk tool. The predicate runs both in Node
// (unit-tested) and inside the app's Hermes runtime (via VISIBILITY_HELPERS_JS), so it
// must stay plain: no optional chaining, no spreads, no closure references.

/**
 * True when a fiber (identified by component name + memoizedProps) is a hidden/inactive
 * navigation scene whose subtree should be skipped during a visibility walk.
 *
 * - Layer A (focus rule): an unfocused react-navigation `Screen` destination wrapper
 *   (carries `route` + boolean `focused`) is a parallel Drawer/Tab destination that is
 *   off-screen. Early-returning at it during descent also AND-chains focus: inner focused
 *   nodes of a pruned ancestor are never reached.
 * - Existing: unfocused native-stack `SceneView`.
 * - Layer B: react-native-screens inactive route — `activityState === 0` on Screen/RNSScreen
 *   (confirmed location), legacy `active === 0` on MaybeScreen — plus generic hidden-view
 *   props (aria-hidden, display:none, etc.).
 */
export function isHiddenNavigationScene(name: string | null, props: any): boolean {
    if (!props) return false;
    if (name === "Screen" && props.focused === false && props.route) return true;
    if (name === "SceneView" && props.focused === false) return true;
    if (name === "Screen" || name === "RNSScreen" || name === "MaybeScreen") {
        if (props.activityState === 0) return true;
        if (props.active === 0) return true;
    }
    if (props["aria-hidden"] === true) return true;
    if (props.accessibilityElementsHidden === true) return true;
    if (props.importantForAccessibility === "no-hide-descendants") return true;
    var s = props.style;
    if (s && !Array.isArray(s) && s.display === "none") return true;
    if (Array.isArray(s)) {
        for (var i = 0; i < s.length; i++) {
            if (s[i] && s[i].display === "none") return true;
        }
    }
    return false;
}

/** JS source defining `isHiddenNavigationScene` for injection into an IIFE expression. */
export const VISIBILITY_HELPERS_JS = `var isHiddenNavigationScene = ${isHiddenNavigationScene.toString()};`;

/** Native-presented sheets whose measureInWindow geometry is untrustworthy. `openMarkers`
 *  are host component names that appear only while the sheet is actually presented. */
export const NATIVE_SHEET_REGISTRY: { component: string; openMarkers: string[]; kind: "sheet" }[] = [
    { component: "TrueSheet", openMarkers: ["TrueSheetContainerView", "TrueSheetContentView"], kind: "sheet" },
];

/** Given the set of component names seen in the tree, return the first open native sheet. */
export function detectNativeSheet(markerNames: string[]): { kind: "sheet"; component: string } | null {
    const seen = new Set(markerNames);
    for (const entry of NATIVE_SHEET_REGISTRY) {
        if (entry.openMarkers.some((m) => seen.has(m))) {
            return { kind: entry.kind, component: entry.component };
        }
    }
    return null;
}

/** Regex alternation (no anchors) of every open marker, for the in-app collection scan. */
export const NATIVE_SHEET_MARKER_RE_SRC = NATIVE_SHEET_REGISTRY.flatMap((e) => e.openMarkers).join("|");
