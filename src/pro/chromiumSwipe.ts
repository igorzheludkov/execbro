/**
 * swipe() on a chromium target. A direction is a mouse-wheel scroll (on a desktop
 * "swipe up" means "show me what is below", and a pointer drag would select text);
 * four coordinates are a real left-button drag, for sliders, resizable panes and
 * pointer-event drag libraries. The wheel is verified by reading the scroll
 * container's offsets before and after, not only by the pixel diff.
 */
import type { ConnectedApp } from "../core/types.js";
import { evaluateJson } from "../core/cdpCommand.js";
import {
    chromiumCapture,
    chromiumDrag,
    chromiumViewport,
    chromiumWheel,
    dragPath,
    pxPerCss,
    scrollVerdict,
    wheelDelta,
    type ScrollDirection,
    type ScrollProbe,
} from "../core/chromium.js";
import { buildScrollProbeJs, SCROLL_READ_JS } from "../core/chromiumScreen.js";
import { verifyChromiumAction, dialogVerification } from "./chromiumTap.js";
import { raceDialog } from "../core/chromiumDialogs.js";

/** Smooth scrolling animates: wait this long, then read until two reads agree. */
const SCROLL_SETTLE_MS = 350;
const SCROLL_SETTLE_MAX_MS = 1000;
const DRAG_DEFAULT_MS = 300;

export interface ChromiumSwipeArgs {
    direction?: ScrollDirection;
    distance?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    durationMs?: number;
    delta?: number;
    burst?: boolean;
    verify?: boolean;
    screenshot?: boolean;
}

const sameOffsets = (a: ScrollProbe, b: ScrollProbe) =>
    a.container === b.container && (a.container === null || (b.container !== null && a.top === b.top && a.left === b.left));

async function settledScroll(app: ConnectedApp): Promise<ScrollProbe> {
    await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
    const deadline = Date.now() + SCROLL_SETTLE_MAX_MS;
    let prev = await evaluateJson<ScrollProbe>(app.ws, SCROLL_READ_JS);
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const next = await evaluateJson<ScrollProbe>(app.ws, SCROLL_READ_JS);
        if (sameOffsets(prev, next)) return next;
        prev = next;
    }
    return prev;
}

export async function chromiumSwipe(app: ConnectedApp, a: ChromiumSwipeArgs) {
    const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true });
    const coords = [a.startX, a.startY, a.endX, a.endY];
    const coordCount = coords.filter((v) => v !== undefined).length;
    if (coordCount > 0 && coordCount < 4 && a.direction === undefined) {
        return fail("swipe needs either all four coordinates (startX/startY/endX/endY in screenshot pixels) or a direction (up/down/left/right, with optional distance in pixels). Got partial coordinates.");
    }
    try {
        const vp = await chromiumViewport(app);
        const k = pxPerCss(vp);
        const drag = coordCount === 4;
        const notes: string[] = [];
        if (a.delta !== undefined) notes.push("delta is iOS-only and was ignored.");
        if (a.burst) notes.push("burst is not supported on chromium yet and was ignored; the regular before/after diff ran.");

        const shouldVerify = a.verify !== false;
        const shouldScreenshot = a.screenshot !== false;
        const body: Record<string, unknown> = { success: true, platform: "chromium", device: app.deviceInfo.deviceName };
        let beforeProbe: ScrollProbe | null = null;
        let wheel: { dx: number; dy: number } | null = null;
        let at: { x: number; y: number };

        if (drag) {
            at = { x: a.startX! / k, y: a.startY! / k };
            body.mode = "drag";
            body.from = { x: a.startX, y: a.startY };
            body.to = { x: a.endX, y: a.endY };
        } else {
            wheel = wheelDelta(a.direction ?? "up", a.distance, vp);
            // The browser scrolls whatever is under the pointer, so the point picks the container.
            at = a.startX !== undefined && a.startY !== undefined
                ? { x: a.startX / k, y: a.startY / k }
                : { x: vp.w / 2, y: vp.h / 2 };
            body.mode = "wheel";
            body.at = { x: Math.round(at.x * k), y: Math.round(at.y * k) };
            beforeProbe = await evaluateJson<ScrollProbe>(app.ws, buildScrollProbeJs(at.x, at.y, wheel.dx !== 0));
        }

        const before = shouldVerify ? await chromiumCapture(app) : null;
        const act = await raceDialog(app.ws, () => drag
            ? chromiumDrag(app, dragPath(at, { x: a.endX! / k, y: a.endY! / k }, a.durationMs ?? DRAG_DEFAULT_MS))
            : chromiumWheel(app, at.x, at.y, wheel!.dx, wheel!.dy));
        if (act.kind === "dialog") {
            body.dialog = act.dialog;
            body.verification = dialogVerification(act.dialog);
            return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: false };
        }

        let warning: string | undefined;
        if (beforeProbe && wheel) {
            const afterProbe = await settledScroll(app);
            const v = scrollVerdict(beforeProbe, afterProbe, wheel);
            const moved = Math.round(v.moved * k);
            body.scrolled = { dx: wheel.dx !== 0 ? moved : 0, dy: wheel.dy !== 0 ? moved : 0, unit: "screenshot px" };
            if (beforeProbe.container !== null) {
                body.container = v.chainedTo ? `${v.chainedTo} (${beforeProbe.container} was at its limit, so the wheel passed on)` : beforeProbe.container;
            }
            if (v.warning) warning = `Wheel delivered but nothing scrolled: ${v.warning}`;
        }
        const { screenshot, verification, dialog } = await verifyChromiumAction(app, before, shouldScreenshot, drag ? "drag" : "wheel", drag ? undefined : 0);
        if (dialog) body.dialog = dialog;

        body.verification = verification;
        if (warning) body.warning = warning;
        if (notes.length) body.note = notes.join(" ");
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
            { type: "text", text: JSON.stringify(body, null, 2) },
        ];
        if (screenshot) content.push({ type: "image", data: screenshot.image, mimeType: "image/jpeg" });
        return {
            content,
            isError: false,
            _meaningful: verification.skipped ? undefined : verification.meaningful,
            _changeRate: verification.skipped ? undefined : verification.changeRate,
        };
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
