import { describe, it, expect } from "@jest/globals";
import { planPinch } from "../../core/pinchGeometry.js";
import {
    MIN_HALF_SEPARATION_PX,
    EDGE_GUARD_PX,
    PRESSURE_DOWN,
} from "../../core/pinchThresholds.js";

const base = {
    focalX: 540,
    focalY: 1200,
    direction: "out" as const,
    scale: 3,
    angleDeg: 0,
    durationMs: 300,
    screenWidth: 1080,
    screenHeight: 2424,
};

const allFrames = (plan: ReturnType<typeof planPinch>) => plan.gestures.flat();

describe("planPinch", () => {
    it("produces two pointers in every frame", () => {
        for (const frame of allFrames(planPinch(base))) {
            expect(frame).toHaveLength(2);
        }
    });

    it("gives the two pointers distinct identifiers", () => {
        const [a, b] = allFrames(planPinch(base))[0];
        expect(a.identifier).toBe(0);
        expect(b.identifier).toBe(1);
    });

    it("releases every sub-gesture with zero pressure", () => {
        for (const gesture of planPinch({ ...base, scale: 20 }).gestures) {
            const last = gesture[gesture.length - 1];
            expect(last.every((p) => p.pressure === 0)).toBe(true);
        }
    });

    it("holds non-zero pressure for every frame before the release", () => {
        const gesture = planPinch(base).gestures[0];
        for (const frame of gesture.slice(0, -1)) {
            expect(frame.every((p) => p.pressure === PRESSURE_DOWN)).toBe(true);
        }
    });

    it("separates the pointers over time when pinching out", () => {
        const frames = planPinch(base).gestures[0];
        const spread = (f: (typeof frames)[number]) => Math.abs(f[1].x - f[0].x);
        expect(spread(frames[frames.length - 1])).toBeGreaterThan(spread(frames[0]));
    });

    it("converges the pointers when pinching in", () => {
        const frames = planPinch({ ...base, direction: "in" }).gestures[0];
        const spread = (f: (typeof frames)[number]) => Math.abs(f[1].x - f[0].x);
        expect(spread(frames[frames.length - 1])).toBeLessThan(spread(frames[0]));
    });

    it("keeps the pointers symmetric about the focal point", () => {
        for (const frame of allFrames(planPinch(base))) {
            expect((frame[0].x + frame[1].x) / 2).toBeCloseTo(base.focalX, 0);
            expect((frame[0].y + frame[1].y) / 2).toBeCloseTo(base.focalY, 0);
        }
    });

    it("places pointers on the vertical axis at 90 degrees", () => {
        const frame = planPinch({ ...base, angleDeg: 90 }).gestures[0][0];
        expect(frame[0].x).toBeCloseTo(frame[1].x, 0);
        expect(frame[0].y).not.toBeCloseTo(frame[1].y, 0);
    });

    it("never starts a contact inside an edge guard", () => {
        // focalX 200 leaves real but limited room, so the guard clamp has to do
        // actual work. A focal point flush against the guard would yield an
        // empty plan and make this assertion vacuous.
        const plan = planPinch({ ...base, focalX: 200, scale: 8 });
        expect(plan.gestures.length).toBeGreaterThan(0);
        for (const frame of allFrames(plan)) {
            for (const p of frame) {
                expect(p.x).toBeGreaterThanOrEqual(EDGE_GUARD_PX.left);
                expect(p.x).toBeLessThanOrEqual(base.screenWidth - EDGE_GUARD_PX.right);
                expect(p.y).toBeGreaterThanOrEqual(EDGE_GUARD_PX.top);
                expect(p.y).toBeLessThanOrEqual(base.screenHeight - EDGE_GUARD_PX.bottom);
            }
        }
    });

    it("keeps contacts far enough apart to read as two fingers", () => {
        const plan = planPinch({ ...base, scale: 50 });
        for (const frame of allFrames(plan)) {
            const gap = Math.hypot(frame[1].x - frame[0].x, frame[1].y - frame[0].y);
            expect(gap).toBeGreaterThanOrEqual(MIN_HALF_SEPARATION_PX * 2 - 1);
        }
    });

    it("splits a large scale into chained sub-gestures", () => {
        expect(planPinch({ ...base, scale: 3 }).gestures.length).toBe(1);
        expect(planPinch({ ...base, scale: 40 }).gestures.length).toBeGreaterThan(1);
    });

    it("scales frame count with duration", () => {
        const short = planPinch({ ...base, durationMs: 100 }).gestures[0].length;
        const long = planPinch({ ...base, durationMs: 600 }).gestures[0].length;
        expect(long).toBeGreaterThan(short);
        expect(short).toBeGreaterThanOrEqual(3);
    });

    it("shrinks the gesture footprint when span is reduced", () => {
        const spread = (plan: ReturnType<typeof planPinch>) => {
            const frames = plan.gestures[0];
            return Math.max(...frames.map((f) => Math.abs(f[1].x - f[0].x)));
        };
        const full = spread(planPinch({ ...base, span: 1 }));
        const half = spread(planPinch({ ...base, span: 0.5 }));
        expect(half).toBeLessThan(full);
        expect(half).toBeCloseTo(full / 2, -1);
    });

    it("keeps a reduced-span pinch-in away from the screen extremes", () => {
        // The case the demo hit: at span 1 a pinch-in starts with its contacts
        // at the very top and bottom, where a status bar or bottom sheet takes
        // the gesture before the zoomable surface sees it.
        const guards = { left: 4, right: 4, top: 200, bottom: 200 };
        const wide = planPinch({ ...base, direction: "in", angleDeg: 90, span: 1, guards });
        const narrow = planPinch({ ...base, direction: "in", angleDeg: 90, span: 0.4, guards });
        const topContact = (plan: ReturnType<typeof planPinch>) => plan.gestures[0][0][0].y;
        expect(topContact(narrow)).toBeGreaterThan(topContact(wide));
    });

    it("keeps the zoom ratio unchanged when span shrinks", () => {
        const ratio = (plan: ReturnType<typeof planPinch>) => plan.endHalf / plan.startHalf;
        expect(ratio(planPinch({ ...base, span: 0.4 }))).toBeCloseTo(
            ratio(planPinch({ ...base, span: 1 })),
            5
        );
    });

    it("refuses a span too small to hold two distinct contacts", () => {
        const plan = planPinch({ ...base, span: 0.001 });
        expect(plan.viable).toBe(false);
        expect(plan.note).toMatch(/span/);
    });

    it("defaults to the full span when span is omitted", () => {
        const omitted = planPinch(base);
        const explicit = planPinch({ ...base, span: 1 });
        expect(omitted.endHalf).toBeCloseTo(explicit.endHalf, 5);
    });

    it("marks a scale of 1 as not viable", () => {
        const plan = planPinch({ ...base, scale: 1 });
        expect(plan.viable).toBe(false);
        expect(plan.note).toBeTruthy();
    });

    it("marks a viable ordinary pinch as viable", () => {
        expect(planPinch(base).viable).toBe(true);
    });

    it("clamps a focal point outside the screen back inside the guards", () => {
        // Off-screen X, vertical finger axis: the clamp pulls the focal point to
        // the left guard, and the fingers still have the whole Y axis to work
        // with, so the plan stays viable and the clamp is observable.
        const plan = planPinch({ ...base, focalX: -200, angleDeg: 90 });
        expect(plan.viable).toBe(true);
        for (const frame of allFrames(plan)) {
            for (const p of frame) {
                expect(p.x).toBe(EDGE_GUARD_PX.left);
                expect(p.y).toBeGreaterThanOrEqual(EDGE_GUARD_PX.top);
                expect(p.y).toBeLessThanOrEqual(base.screenHeight - EDGE_GUARD_PX.bottom);
            }
        }
    });
});
