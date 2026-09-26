/**
 * press_key on a chromium target: real key events through Input.dispatchKeyEvent,
 * sent to whatever has focus (or to a testID / text target focused first). The
 * response names document.activeElement before and after, so Tab navigation and
 * a field losing focus are observable without a screenshot.
 */
import type { ConnectedApp } from "../core/types.js";
import { evaluateJson } from "../core/cdpCommand.js";
import { buildDomKeyFocusJs, chromiumKey, collectDomTargets, pickDomTarget, MOD, type KeyDef } from "../core/chromium.js";
import { ACTIVE_ELEMENT_JS } from "../core/chromiumScreen.js";

/** Lets a keydown handler re-render before the focused element is read back. */
const KEY_SETTLE_MS = 80;

type Active = { element: string; testID: string | null; label: string | null; placeholder: string | null; value: string | null } | null;

export async function chromiumPressKey(
    app: ConnectedApp,
    a: { input: string; combo: { mods: number; key: KeyDef }; repeat: number; testID?: string; text?: string }
) {
    const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true });
    try {
        if (a.testID !== undefined || a.text !== undefined) {
            const found = await collectDomTargets(app, { mode: "tap", testID: a.testID, text: a.text });
            const pick = pickDomTarget(found.candidates, a.text, undefined);
            if (pick.kind === "none") {
                return fail(`No visible element matches ${JSON.stringify({ testID: a.testID, text: a.text })}. On chromium, testID matches data-testid / data-test-id / id.`);
            }
            if (pick.kind === "ambiguous") {
                const list = pick.matches.slice(0, 10).map((c) => `<${c.tag}>${c.testID ? ` testID=${c.testID}` : ""} "${c.text.slice(0, 40)}"`);
                return fail(`${pick.matches.length} elements match this target, so the key would go to a guess. Use a testID. Matches: ${list.join("; ")}`);
            }
            const r = await evaluateJson<{ error?: string }>(app.ws, buildDomKeyFocusJs(pick.cand.i));
            if (r.error) return fail(r.error);
        }
        const focusedBefore = await evaluateJson<Active>(app.ws, ACTIVE_ELEMENT_JS);
        for (let n = 0; n < a.repeat; n++) await chromiumKey(app, a.combo);
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const focusedAfter = await evaluateJson<Active>(app.ws, ACTIVE_ELEMENT_JS);

        const body: Record<string, unknown> = {
            success: true,
            platform: "chromium",
            device: app.deviceInfo.deviceName,
            key: a.input,
            repeat: a.repeat,
            focusedBefore,
            focusedAfter,
        };
        if (a.combo.mods & (MOD.Meta | MOD.Control) && /^[acvxz]$/.test(a.combo.key.key)) {
            body.note = "The key events were delivered and the page's own handlers ran, but Chromium does not run editing commands (select all, copy, paste, cut, undo) for synthesized keys.";
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: false };
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
