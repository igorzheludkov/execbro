/**
 * handle_dialog on a chromium page: answer the open alert / confirm / prompt with
 * Page.handleJavaScriptDialog and report what the page got back.
 */
import type { ConnectedApp } from "./types.js";
import { sendCdpCommand } from "./cdpCommand.js";
import { connectedApps } from "./state.js";
import { openDialog, lastClosedDialog, waitForDialogClosed, formatDialog, type DialogInfo } from "./chromiumDialogs.js";

const CLOSE_WAIT_MS = 2000;

/** The one chromium app with an open dialog, for a bare handle_dialog in a mixed session. */
export function findAppWithOpenDialog(): ConnectedApp | null {
    const withDialog = [...connectedApps.values()].filter((a) => a.platform === "chromium" && openDialog(a.ws));
    return withDialog.length === 1 ? withDialog[0] : null;
}

/**
 * The page handle_dialog answers. A named device is taken as given (target is
 * chromiumAppFor's pick). A bare call prefers the one page with a dialog open:
 * the first chromium window may not be it, and in a mixed session target is null
 * because the gate's platform guess fails open to mobile.
 */
export function pickDialogApp(target: ConnectedApp | null, device: string | undefined): ConnectedApp | null {
    if (device) return target;
    if (target && openDialog(target.ws)) return target;
    return findAppWithOpenDialog() ?? target;
}

function noDialog(app: ConnectedApp, last: (DialogInfo & { result?: boolean }) | null) {
    return {
        isError: true,
        text: `No dialog is open on ${app.deviceInfo.deviceName}.` +
            (last ? ` The last one was ${formatDialog(last)}${last.result !== undefined ? `, closed with result ${last.result}` : ""} (answered here, by the user, or by another DevTools client).` : ""),
    };
}

export async function answerDialog(app: ConnectedApp, a: { action: "accept" | "dismiss"; promptText?: string }): Promise<{ text: string; isError: boolean }> {
    const d = openDialog(app.ws);
    if (!d) return noDialog(app, lastClosedDialog(app.ws));
    if (a.promptText !== undefined && d.type !== "prompt") {
        return { isError: true, text: `promptText only applies to a prompt; the open dialog is ${formatDialog(d)}. Call again without promptText.` };
    }
    try {
        await sendCdpCommand(app.ws, "Page.handleJavaScriptDialog", {
            accept: a.action === "accept",
            ...(a.promptText !== undefined ? { promptText: a.promptText } : {}),
        });
    } catch (err) {
        // Closed by hand between our read and the answer; the Closed event is on its way.
        if (/No dialog is showing/i.test(err instanceof Error ? err.message : String(err))) return noDialog(app, lastClosedDialog(app.ws) ?? d);
        throw err;
    }
    const closed = await waitForDialogClosed(app.ws, CLOSE_WAIT_MS);
    const verb = a.action === "accept" ? "accepted" : "dismissed";
    if (!closed) {
        return { isError: true, text: `Sent ${a.action} for ${formatDialog(d)}, but the page did not report it closed within ${CLOSE_WAIT_MS} ms. Take a screenshot to see the window.` };
    }
    const last = lastClosedDialog(app.ws);
    return {
        isError: false,
        text: JSON.stringify({
            success: true,
            device: app.deviceInfo.deviceName,
            answered: `${verb} ${formatDialog(d)}`,
            result: last?.result,
            ...(last?.userInput !== undefined ? { userInput: last.userInput } : {}),
            note: d.type === "beforeunload"
                ? (a.action === "accept" ? "The page is leaving; run get_apps if the window closed." : "The page stays.")
                : "The page resumed. Take a screenshot or get_screen_state to see what the answer did.",
        }, null, 2),
    };
}
