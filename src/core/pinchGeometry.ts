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

export interface PinchRequest {
    focalX: number;
    focalY: number;
    direction: "in" | "out";
    scale: number;
    angleDeg: number;
    durationMs: number;
    screenWidth: number;
    screenHeight: number;
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
 * Measurement showed the OS never claims a two-pointer gesture, so the guards
 * involved here are only about staying within the display — see
 * pinchThresholds.EDGE_GUARD_PX.
 */
function maxHalfSeparation(req: PinchRequest, fx: number, fy: number): number {
    const rad = (req.angleDeg * Math.PI) / 180;
    const ax = Math.abs(Math.cos(rad));
    const ay = Math.abs(Math.sin(rad));

    // Along each axis, how far a contact may travel from the focal point
    // before it leaves the usable area. An axis the fingers do not move along
    // imposes no limit, hence Infinity when its component is ~0.
    const limitX = ax < 1e-6
        ? Infinity
        : Math.min(fx - EDGE_GUARD_PX.left, req.screenWidth - EDGE_GUARD_PX.right - fx) / ax;
    const limitY = ay < 1e-6
        ? Infinity
        : Math.min(fy - EDGE_GUARD_PX.top, req.screenHeight - EDGE_GUARD_PX.bottom - fy) / ay;

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
    const fx = clamp(
        request.focalX,
        EDGE_GUARD_PX.left,
        request.screenWidth - EDGE_GUARD_PX.right
    );
    const fy = clamp(
        request.focalY,
        EDGE_GUARD_PX.top,
        request.screenHeight - EDGE_GUARD_PX.bottom
    );

    const maxHalf = maxHalfSeparation(request, fx, fy);
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

    // The wide end uses the full available span; the narrow end is the wide
    // end divided by the per-gesture ratio, floored so the contacts stay
    // distinguishable as two fingers.
    const wide = maxHalf;
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
