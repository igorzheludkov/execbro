import type { TouchPoint } from "./emulatorGrpc.js";
import {
    EDGE_GUARD_PX,
    EDGE_UTILIZATION,
    FRAME_INTERVAL_MS,
    MAX_RATIO_PER_GESTURE,
    MIN_HALF_SEPARATION_PX,
    MIN_TRAVEL_PX,
    PRESSURE_DOWN,
} from "./pinchThresholds.js";

export interface EdgeGuards {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface PinchRequest {
    focalX: number;
    focalY: number;
    direction: "in" | "out";
    scale: number;
    angleDeg: number;
    durationMs: number;
    screenWidth: number;
    screenHeight: number;
    /**
     * Per-device no-go margins. The top and bottom ones are the real status
     * and navigation bar heights, which vary by device — a contact that goes
     * down inside either is delivered to SystemUI, not the app. Defaults to
     * EDGE_GUARD_PX when the device cannot be queried.
     */
    guards?: EdgeGuards;
    /**
     * Fraction of the available span the gesture may occupy, 0-1. Defaults to
     * 1 (use as much of the screen as fits).
     *
     * This exists because the wide end of a gesture is otherwise always
     * maximal, which is fine for a pinch-out — its contacts START near the
     * focal point — but not for a pinch-in, whose contacts start at the
     * widest separation and so land at the screen extremes. On a screen with
     * a top bar or bottom sheet those views take the gesture and the target
     * never sees it. Shrinking the span keeps both contacts over the surface
     * being zoomed.
     */
    span?: number;
}

export interface PinchPlan {
    /** Sub-gestures -> frames -> exactly two contacts. */
    gestures: TouchPoint[][][];
    startHalf: number;
    endHalf: number;
    viable: boolean;
    note?: string;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Largest half-separation that keeps both contacts on screen, given a focal
 * point and a finger axis.
 *
 * The left/right guards are only about staying on screen — measurement showed
 * the back-gesture strips never claim a two-pointer gesture. The top/bottom
 * ones are real: the status and navigation bars are separate windows that
 * swallow any contact going down inside them. See pinchThresholds.EDGE_GUARD_PX.
 */
function maxHalfSeparation(
    req: PinchRequest,
    fx: number,
    fy: number,
    guards: EdgeGuards
): number {
    const rad = (req.angleDeg * Math.PI) / 180;
    const ax = Math.abs(Math.cos(rad));
    const ay = Math.abs(Math.sin(rad));

    // Along each axis, how far a contact may travel from the focal point
    // before it leaves the usable area. An axis the fingers do not move along
    // imposes no limit, hence Infinity when its component is ~0.
    const limitX = ax < 1e-6
        ? Infinity
        : Math.min(fx - guards.left, req.screenWidth - guards.right - fx) / ax;
    const limitY = ay < 1e-6
        ? Infinity
        : Math.min(fy - guards.top, req.screenHeight - guards.bottom - fy) / ay;

    return Math.max(0, Math.min(limitX, limitY) * EDGE_UTILIZATION);
}

/** Split a ratio into equal sub-ratios, none exceeding MAX_RATIO_PER_GESTURE. */
function decompose(ratio: number): { count: number; per: number } {
    if (ratio <= MAX_RATIO_PER_GESTURE) return { count: 1, per: ratio };
    const count = Math.ceil(Math.log(ratio) / Math.log(MAX_RATIO_PER_GESTURE));
    return { count, per: ratio ** (1 / count) };
}

function buildFrames(
    fx: number,
    fy: number,
    angleDeg: number,
    fromHalf: number,
    toHalf: number,
    durationMs: number
): TouchPoint[][] {
    const rad = (angleDeg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    // At least 2 steps (3 frames) so there is always a down, a move, and an up.
    const steps = Math.max(2, Math.round(durationMs / FRAME_INTERVAL_MS));

    const frames: TouchPoint[][] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const half = fromHalf + (toHalf - fromHalf) * t;
        const pressure = i === steps ? 0 : PRESSURE_DOWN;
        frames.push([
            { x: Math.round(fx - half * ux), y: Math.round(fy - half * uy), identifier: 0, pressure },
            { x: Math.round(fx + half * ux), y: Math.round(fy + half * uy), identifier: 1, pressure },
        ]);
    }
    return frames;
}

/**
 * Turn a focal point and a scale into interpolated two-pointer frames.
 *
 * The wide end of the gesture is sized to the largest span that fits on
 * screen, and the narrow end follows from the requested ratio. Ratios too
 * large for one gesture are chained.
 */
export function planPinch(request: PinchRequest): PinchPlan {
    const guards = request.guards ?? EDGE_GUARD_PX;
    const fx = clamp(request.focalX, guards.left, request.screenWidth - guards.right);
    const fy = clamp(request.focalY, guards.top, request.screenHeight - guards.bottom);

    const maxHalf = maxHalfSeparation(request, fx, fy, guards);
    if (maxHalf < MIN_HALF_SEPARATION_PX) {
        return {
            gestures: [],
            startHalf: 0,
            endHalf: 0,
            viable: false,
            note:
                "No room for two contacts around this focal point without leaving the screen. " +
                "Move the focal point toward the centre.",
        };
    }

    const ratio = Math.abs(request.scale);
    if (!Number.isFinite(ratio) || ratio <= 1) {
        return {
            gestures: [],
            startHalf: 0,
            endHalf: 0,
            viable: false,
            note: `scale must be greater than 1 (got ${request.scale}); 1 would move the fingers nowhere.`,
        };
    }

    const { count, per } = decompose(ratio);

    // The wide end uses the requested fraction of the available span; the
    // narrow end is the wide end divided by the per-gesture ratio, floored so
    // the contacts stay distinguishable as two fingers.
    const spanFraction = clamp(
        Number.isFinite(request.span as number) ? (request.span as number) : 1,
        0,
        1
    );
    const wide = maxHalf * spanFraction;
    if (wide < MIN_HALF_SEPARATION_PX) {
        return {
            gestures: [],
            startHalf: 0,
            endHalf: 0,
            viable: false,
            note:
                `span ${spanFraction} leaves only ${Math.round(wide)}px between the contacts, ` +
                `below the ${MIN_HALF_SEPARATION_PX}px needed for two distinct fingers. Increase span.`,
        };
    }
    const narrow = Math.max(MIN_HALF_SEPARATION_PX, wide / per);

    const gestures: TouchPoint[][][] = [];
    for (let i = 0; i < count; i++) {
        gestures.push(
            request.direction === "out"
                ? buildFrames(fx, fy, request.angleDeg, narrow, wide, request.durationMs)
                : buildFrames(fx, fy, request.angleDeg, wide, narrow, request.durationMs)
        );
    }

    const travel = Math.abs(wide - narrow) * 2;
    const viable = travel >= MIN_TRAVEL_PX;

    return {
        gestures,
        startHalf: request.direction === "out" ? narrow : wide,
        endHalf: request.direction === "out" ? wide : narrow,
        viable,
        note: viable
            ? undefined
            : `Fingers would move only ${Math.round(travel)}px apart, below the ` +
              `${MIN_TRAVEL_PX}px a recognizer responds to. Increase scale or pick a focal ` +
              `point with more room.`,
    };
}
