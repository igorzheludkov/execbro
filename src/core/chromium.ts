/**
 * Chromium (Electron / Chrome) screen, pointer and text primitives.
 *
 * Coordinate contract: tools speak delivered-screenshot pixels, the Input domain
 * speaks CSS pixels, and pxPerCss is the only conversion between them. It is
 * derived from the live viewport on every call rather than stored, so a resized
 * window cannot leave a stale factor behind, and the capture resizes to exactly
 * round(css * pxPerCss) so the image and the conversion agree by construction.
 *
 * Design: docs/devtools-core/specs/2026-09-19-chromium-platform-support-design.md (section 4)
 */
import sharp from "sharp";
import type { ConnectedApp } from "./types.js";
import { sendCdpCommand, evaluateJson } from "./cdpCommand.js";

/** Same API image cap ios.ts and android.ts apply. */
export const CHROMIUM_MAX_DIMENSION = 2000;
export const CAPTURE_TIMEOUT_MS = 8000;

export interface ChromiumViewport {
    w: number;
    h: number;
    dpr: number;
}

/** Delivered-screenshot pixels per CSS pixel: devicePixelRatio, lowered only when the capture would exceed the cap. */
export function pxPerCss(vp: ChromiumViewport): number {
    const longest = Math.max(vp.w, vp.h);
    return longest * vp.dpr > CHROMIUM_MAX_DIMENSION ? CHROMIUM_MAX_DIMENSION / longest : vp.dpr;
}

export const VIEWPORT_JS = "JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })";

export function chromiumViewport(app: ConnectedApp): Promise<ChromiumViewport> {
    return evaluateJson<ChromiumViewport>(app.ws, VIEWPORT_JS);
}

export interface ChromiumShot {
    buffer: Buffer;
    width: number;
    height: number;
    /** raw / delivered, 1 unless downscaled. Same meaning as TapScreenshot.scaleFactor. */
    scaleFactor: number;
    viewport: ChromiumViewport;
}

export async function chromiumCapture(app: ConnectedApp): Promise<ChromiumShot> {
    const viewport = await chromiumViewport(app);
    let data: string;
    try {
        ({ data } = await sendCdpCommand<{ data: string }>(app.ws, "Page.captureScreenshot", { format: "png" }, CAPTURE_TIMEOUT_MS));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            /timed out/.test(msg)
                ? `${msg}. A hidden or minimised window may not paint, and Chromium cannot capture what it does not paint: show the window and retry.`
                : msg
        );
    }
    const k = pxPerCss(viewport);
    const width = Math.round(viewport.w * k);
    const height = Math.round(viewport.h * k);
    const png = Buffer.from(data, "base64");
    const meta = await sharp(png).metadata();
    const img = meta.width === width && meta.height === height ? sharp(png) : sharp(png).resize(width, height, { fit: "fill" });
    return {
        buffer: await img.jpeg({ quality: 85 }).toBuffer(),
        width,
        height,
        scaleFactor: viewport.dpr / k,
        viewport,
    };
}

/** A left click at CSS pixel (x, y). holdMs > 0 holds the button down that long. */
export async function chromiumClick(app: ConnectedApp, x: number, y: number, holdMs = 0): Promise<void> {
    const send = (params: Record<string, unknown>) => sendCdpCommand(app.ws, "Input.dispatchMouseEvent", params);
    await send({ type: "mouseMoved", x, y });
    await send({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    await send({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/** Insert text at the focused element's caret, through the browser's own input pipeline (fires input events React sees). */
export async function chromiumInsertText(app: ConnectedApp, text: string): Promise<void> {
    await sendCdpCommand(app.ws, "Input.insertText", { text });
}
