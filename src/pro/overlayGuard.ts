/**
 * Pre-dispatch overlay guard for `tap`.
 *
 * The OS always delivers a touch to the topmost view, so a coordinate tap physically
 * cannot reach an element that an overlay is painted over — the touch goes to the
 * overlay. That is correct behaviour and nothing about tap dispatch should change.
 *
 * What must change is that execbro not fire such a tap at all. In the reported case the
 * touch did not vanish harmlessly: it opened a sheet's network-request detail view, so
 * execbro mutated app state the agent never asked to change and was never told about.
 * Declining is strictly better, and the agent's correct next move — dismiss the overlay,
 * then retry — is the same either way.
 *
 * The check runs on the resolved TARGET, not on the strategy, because every strategy
 * (fiber, accessibility, OCR, raw coordinates) funnels into a coordinate tap.
 */

import { getScreenState } from "../core/screenState.js";
import type { ScreenState, ScreenStatePressable } from "../core/screenState.js";
import { screenStateToScreenSpace, screenStateToDeliveredPx } from "../core/screenSpace.js";
import { resolveScreenSpaceMetrics } from "../core/screenSpaceDevice.js";

export type OverlayVerdict =
    /** Nothing reachable at the target; an overlay is painted over it. Do not dispatch. */
    | { kind: "blocked"; element: string; overlay: string }
    /**
     * A coordinate that an overlay's own control occupies, while a covered element also
     * sits underneath it. The tap is legitimate — the OS will deliver it to the overlay
     * control, which is a real element — but the caller may well have been aiming at the
     * thing behind. Dispatch, and say which one actually got it.
     */
    | { kind: "shadowed"; hit: string; covered: string; overlay: string };

export interface OverlayGuardQuery {
    text?: string;
    testID?: string;
    component?: string;
    x?: number;
    y?: number;
}

function describePressable(p: ScreenStatePressable): string {
    const tag = p.component ? `<${p.component} />` : "element";
    const label = p.label ? ` "${p.label}"` : "";
    const tid = p.testID ? ` testID="${p.testID}"` : "";
    return `${tag}${label}${tid}`;
}

function describeOverlay(o: { type: string; title: string | null }): string {
    // "Unknown" is the internal bucket for a sheet recognised by geometry rather than by
    // component name. Surfacing that word to an agent reads like a failure, when the
    // finding itself is certain — it is the overlay's identity that is unknown, not its
    // presence.
    const kind = o.type === "Unknown" ? "overlay" : o.type;
    return o.title ? `${kind} "${o.title}"` : kind;
}

/** Smallest pressable whose box contains the point — the innermost, most specific hit. */
function hitAt(candidates: ScreenStatePressable[], x: number, y: number): ScreenStatePressable | null {
    let best: ScreenStatePressable | null = null;
    let bestArea = Infinity;
    for (const p of candidates) {
        const b = p.bounds;
        if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) continue;
        const area = b.width * b.height;
        if (area < bestArea) {
            best = p;
            bestArea = area;
        }
    }
    return best;
}

/**
 * Any provided field matching is a match — deliberately not a priority chain.
 *
 * tap itself tries testID, then text, then component, and settles for whichever resolves.
 * A guard that only consulted the highest-priority field would wave through
 * `tap({testID: "nope", text: "State, tab, 2 of 4"})`: the testID matches nothing, so the
 * chain returns "not found" and dispatch proceeds — on the text, straight into the
 * overlay. Which is exactly the bug, reached by a different door.
 */
function matchesQuery(p: ScreenStatePressable, q: OverlayGuardQuery): boolean {
    if (q.testID && p.testID === q.testID) return true;
    if (q.text) {
        const hay = `${p.label ?? ""} ${p.nearbyText ?? ""}`.toLowerCase();
        if (hay.includes(q.text.toLowerCase())) return true;
    }
    if (q.component && p.component && p.component.toLowerCase().includes(q.component.toLowerCase())) {
        return true;
    }
    return false;
}

/**
 * The decision itself, over a screen state whose coordinates are already in the caller's
 * delivered-pixel space. Pure and exported so the refusal rules — the ones that can break
 * every tap in the product if they are wrong — are testable without a device.
 *
 * Returns null for anything short of a confident "blocked". A guard that fires on
 * uncertainty blocks legitimate taps, which is a worse failure than the mis-delivery it
 * is trying to prevent.
 */
export function decideOverlayBlock(
    ss: ScreenState,
    query: OverlayGuardQuery
): OverlayVerdict | null {
    if (!ss.overlays || ss.overlays.length === 0) return null;

    const blocked = ss.pressables.filter((p) => p.blockedByOverlay);
    if (blocked.length === 0) return null;

    // Everything a touch CAN reach: root pressables that nothing covers, plus the
    // overlays' own controls. The latter are the whole point of an open sheet and are
    // stored separately from ss.pressables — omitting them made the guard refuse taps on
    // the sheet itself, because the only element it found under the point was the covered
    // one behind it.
    const reachable: ScreenStatePressable[] = ss.pressables.filter((p) => !p.blockedByOverlay);
    const overlayOwned = new Set<ScreenStatePressable>();
    for (const o of ss.overlays) {
        for (const p of o.pressables ?? []) {
            reachable.push(p);
            overlayOwned.add(p);
        }
    }

    // Safety valve. If the model says nothing at all on screen can be tapped, the model is
    // far likelier to be wrong than the screen is to be inert — a `fullCover` overlay
    // expands its block region to the entire viewport, so one misclassification there
    // would refuse every tap in the app with no way back. Declining to judge keeps this
    // guard's worst case "behaves like before" instead of "tap is dead".
    if (reachable.length === 0) return null;

    const overlayNames = ss.overlays.map(describeOverlay).join(", ");

    let target: ScreenStatePressable | null = null;
    if (query.x !== undefined && query.y !== undefined) {
        // Whatever reachable element sits under the point is what the OS will deliver to,
        // whether it belongs to the app or to the sheet. The tap is legitimate.
        const hit = hitAt(reachable, query.x, query.y);
        if (hit) {
            // ...but if a covered element is under the same point and the winner is the
            // overlay's, the caller was plausibly aiming at the thing behind. Dispatching
            // silently here is the original bug in miniature: the right element receives
            // the touch, and the caller is never told it was not the one they meant.
            const covered = hitAt(blocked, query.x, query.y);
            if (covered && overlayOwned.has(hit)) {
                return {
                    kind: "shadowed",
                    hit: describePressable(hit),
                    covered: describePressable(covered),
                    overlay: overlayNames
                };
            }
            return null;
        }
        target = hitAt(blocked, query.x, query.y);
    } else {
        // A named target that also exists reachable somewhere on screen is fine.
        if (reachable.some((p) => matchesQuery(p, query))) return null;
        target = blocked.find((p) => matchesQuery(p, query)) ?? null;
    }
    if (!target) return null;

    return { kind: "blocked", element: describePressable(target), overlay: overlayNames };
}

/**
 * Read the current screen, normalise it into the caller's coordinate space, and apply
 * {@link decideOverlayBlock}. Null on any I/O failure — see that function's contract.
 */
export async function checkOverlayBlocking(args: {
    query: OverlayGuardQuery;
    platform: "ios" | "android";
    udid?: string;
    deviceId?: string;
    deviceName?: string;
}): Promise<OverlayVerdict | null> {
    try {
        const [res, metrics] = await Promise.all([
            getScreenState({ device: args.deviceName }),
            resolveScreenSpaceMetrics({
                platform: args.platform,
                udid: args.udid,
                deviceId: args.deviceId
            })
        ]);
        if (!res.success || !res.screenState) return null;

        // Inset then scale — the same normalisation the layout tools emit with, so these
        // bounds and the caller's coordinates are the one canonical delivered-pixel space.
        return decideOverlayBlock(
            screenStateToDeliveredPx(screenStateToScreenSpace(res.screenState, metrics), metrics),
            args.query
        );
    } catch {
        // Best-effort: a guard that throws must never turn a valid tap into an error.
        return null;
    }
}
