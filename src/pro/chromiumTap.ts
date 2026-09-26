/**
 * tap() on a chromium target: find the element in the DOM, scroll it into view,
 * and click its centre with real CDP mouse events, so the page's own handlers run
 * exactly as they would for a user. Verification is the same before/after pixel
 * diff the mobile path uses.
 */
import type { ConnectedApp } from "../core/types.js";
import type { TapOptions, TapQuery, TapResult, TapScreenshot, TapVerification } from "./tap.js";
import { buildVerificationExplanation } from "./tap.js";
import { compareScreenshots } from "./screenshot-diff.js";
import {
    chromiumCapture,
    chromiumClick,
    chromiumViewport,
    collectDomTargets,
    pickDomTarget,
    prepareDomTarget,
    pxPerCss,
    type ChromiumShot,
} from "../core/chromium.js";
import { raceDialog, formatDialog, type DialogInfo } from "../core/chromiumDialogs.js";

/** Long enough for a click's re-render and a CSS transition's first frames. */
const SETTLE_MS = 350;

export async function chromiumTap(
    app: ConnectedApp,
    query: TapQuery,
    options: Pick<TapOptions, "index" | "duration" | "screenshot" | "verify">
): Promise<TapResult> {
    const base = { query, platform: "chromium", device: app.deviceInfo.deviceName, method: "cdp" };
    try {
        let css: { x: number; y: number };
        let k: number;
        let pressed: string | undefined;
        let warning: string | undefined;

        if (query.x !== undefined && query.y !== undefined) {
            k = pxPerCss(await chromiumViewport(app));
            css = { x: query.x / k, y: query.y / k };
        } else {
            const found = await collectDomTargets(app, {
                mode: "tap",
                testID: query.testID,
                text: query.text,
                component: query.component,
            });
            k = pxPerCss(found.viewport);
            const pick = pickDomTarget(found.candidates, query.text, options.index);
            if (pick.kind === "ambiguous") {
                return {
                    ...base,
                    success: false,
                    ambiguous: true,
                    error: `Ambiguous: ${pick.matches.length} elements match this query — use index= to pick one`,
                    matches: pick.matches.map((c, n) => ({
                        index: n,
                        component: c.tag,
                        text: c.text,
                        testID: c.testID,
                        x: Math.round((c.rect.x + c.rect.w / 2) * k),
                        y: Math.round((c.rect.y + c.rect.h / 2) * k),
                    })),
                };
            }
            if (pick.kind === "none") {
                return {
                    ...base,
                    success: false,
                    error: `No visible element matches ${JSON.stringify({ testID: query.testID, text: query.text, component: query.component })}` +
                        (options.index !== undefined ? ` at index ${options.index}` : "") + ".",
                    suggestion:
                        "On chromium, testID matches data-testid / data-test-id / id, text matches visible text, component matches a React component name. " +
                        "Take screenshot({ device }) and tap(x, y), or use find_components to discover component names.",
                };
            }
            const prep = await prepareDomTarget(app, pick.cand.i);
            css = { x: prep.x, y: prep.y };
            pressed = `<${pick.cand.tag}>${pick.cand.text ? ` "${pick.cand.text.slice(0, 60)}"` : ""}`;
            const notes: string[] = [];
            // The before-frame is taken after the scroll, so without this a click
            // with no visible effect reads as a miss while the page visibly moved.
            if (prep.scrolled) notes.push("The element was off-screen, so it was scrolled into view first; the verification diff covers the click only.");
            if (prep.covered) {
                notes.push(`The element's centre is covered by ${prep.covered}, so the click landed on that instead. ` +
                    "Close the overlay first, or tap the covering element deliberately.");
            }
            if (notes.length) warning = notes.join(" ");
        }

        const shouldVerify = options.verify !== false;
        const shouldScreenshot = options.screenshot !== false;
        const before = shouldVerify ? await chromiumCapture(app) : null;
        const click = await raceDialog(app.ws, () => chromiumClick(app, css.x, css.y, options.duration ?? 0));
        const { screenshot, verification, dialog } = click.kind === "dialog"
            ? { screenshot: undefined, verification: dialogVerification(click.dialog), dialog: click.dialog }
            : await verifyChromiumAction(app, before, shouldScreenshot, "click");

        return {
            ...base,
            success: true,
            pressed,
            tappedAt: { x: Math.round(css.x * k), y: Math.round(css.y * k) },
            convertedTo: { x: Math.round(css.x), y: Math.round(css.y), unit: "css" },
            screenshot,
            verification,
            dialog,
            warning,
        };
    } catch (err) {
        return { ...base, success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * After an input action: settle, capture, and diff against the before-frame.
 * Shared by tap and swipe so both report verification the same way.
 */
export async function verifyChromiumAction(
    app: ConnectedApp,
    before: ChromiumShot | null,
    shouldScreenshot: boolean,
    action: string,
    settleMs = SETTLE_MS
): Promise<{ screenshot?: TapScreenshot; verification: TapVerification; dialog?: DialogInfo }> {
    let screenshot: TapScreenshot | undefined;
    let verification: TapVerification = {
        skipped: true,
        skippedReason: "verify=false",
        explanation: "Verification skipped (verify=false).",
    };
    let after: ChromiumShot | undefined;
    if (before || shouldScreenshot) {
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
        // The action is already delivered. A popover that hides itself on the
        // click ("Save & close") leaves nothing to capture, and reporting that
        // as a failure invites a retry that acts twice.
        try {
            const shot = await raceDialog(app.ws, () => chromiumCapture(app));
            if (shot.kind === "dialog") return { verification: dialogVerification(shot.dialog), dialog: shot.dialog };
            after = shot.value;
        } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            verification = {
                ...(before ? { meaningful: true } : { skipped: true, skippedReason: "no after-frame" }),
                explanation: `The ${action} was delivered, then the window could not be captured: ${why} It most likely hid itself in response to the ${action}.`,
            };
        }
    }
    if (after) {
        if (shouldScreenshot) {
            screenshot = { image: after.buffer.toString("base64"), width: after.width, height: after.height, scaleFactor: after.scaleFactor };
        }
        if (before) {
            const d = await compareScreenshots(before.buffer, after.buffer, { regions: true });
            verification = {
                meaningful: d.changed,
                changeRate: d.changeRate,
                changedPixels: d.changedPixels,
                totalPixels: d.totalPixels,
                regions: d.regions,
                explanation: buildVerificationExplanation({
                    meaningful: d.changed,
                    changeRate: d.changeRate,
                    changedPixels: d.changedPixels,
                    totalPixels: d.totalPixels,
                    regions: d.regions,
                    action: action === "click" ? "tap" : "swipe",
                }),
            };
        }
    }
    return { screenshot, verification };
}

/** Verification when a JavaScript dialog paused the page: nothing can be captured until it is answered. */
export function dialogVerification(d: DialogInfo): TapVerification {
    return {
        skipped: true,
        skippedReason: "dialog open",
        explanation: `The input was delivered and opened ${formatDialog(d)}. The page is paused until it is answered: call handle_dialog({ action: "accept" }) or ({ action: "dismiss" }), then take a screenshot.`,
    };
}
