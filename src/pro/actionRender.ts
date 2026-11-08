/**
 * What tap and swipe hand the agent by default: what happened (outcome), whether the
 * screen changed and where, and whatever it needs to act on a failure. Pixel
 * statistics, converted coordinates and the query echo inform nothing it can act on
 * and stayed in context for every later turn; `verbose: true` brings them back.
 */

import type { ActionOutcome } from "../core/actionOutcome.js";
import type { TapResult, TapVerification } from "./tap.js";
import type { ScrollProbe } from "../core/swipeDiagnosis.js";

const MAX_REGIONS = 5;
const NATIVE_CLASS = /^(android\.|XCUIElementType|RCT)/;

export function compactVerification(v: TapVerification): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (v.skipped) out.skipped = true;
    if (v.skippedReason) out.skippedReason = v.skippedReason;
    if (v.meaningful !== undefined) out.meaningful = v.meaningful;
    if (v.regions?.length) {
        out.regions = v.regions
            .slice(0, MAX_REGIONS)
            .map((r) => `(${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)}) ${r.width}x${r.height}`);
    }
    if (v.kind) out.kind = v.kind;
    if (v.transientChangeDetected !== undefined) out.transientChangeDetected = v.transientChangeDetected;
    if (v.burstGroupId) out.burstGroupId = v.burstGroupId;
    // When the screen changed, the explanation is boilerplate; when it did not, or the
    // check never ran, it is the diagnosis.
    if (v.meaningful !== true && v.explanation) out.explanation = v.explanation;
    return out;
}

function describeTarget(r: TapResult): string {
    const q = r.query ?? {};
    let target = q.testID !== undefined ? `testID="${q.testID}"`
        : q.text !== undefined ? `text="${q.text}"`
        : q.component !== undefined ? `component="${q.component}"`
        : q.x !== undefined && q.y !== undefined ? `(${q.x}, ${q.y})`
        : "";
    if (r.text && r.text !== q.text) target += ` → "${r.text}"`;
    // Only a strategy that walked React knows a component; accessibility reports an AX role or native class.
    const reactComponent = r.method !== "accessibility" && r.component && !NATIVE_CLASS.test(r.component);
    if (reactComponent && r.component !== q.component) target += ` <${r.component}>`;
    return target.trim();
}

const KEPT: Array<keyof TapResult> = [
    "warning", "error", "suggestion", "attempted", "matches", "ambiguous", "switch", "longPress", "dialog", "missDiagnosis",
];

export function renderTapResponse(
    r: TapResult,
    outcome: ActionOutcome | null,
    opts: { verbose: boolean; showDeviceNote: boolean }
): Record<string, unknown> {
    if (opts.verbose) {
        const { screenshot: _screenshot, ...rest } = r;
        return { ...rest, ...(outcome && { outcome }) };
    }
    const out: Record<string, unknown> = { success: r.success };
    if (r.method) out.method = r.method;
    const target = describeTarget(r);
    if (target) out.target = target;
    if (r.tappedAt) out.tappedAt = r.tappedAt;
    if (outcome && Object.keys(outcome).length > 0) out.outcome = outcome;
    if (r.verification) out.verification = compactVerification(r.verification);
    for (const k of KEPT) if (r[k] !== undefined) out[k] = r[k];
    if (opts.showDeviceNote && r.deviceNote) out.deviceNote = r.deviceNote;
    return out;
}

/** The scroll container's offset across a swipe, from the probes before and after it. */
export function formatScroll(before: ScrollProbe, after: ScrollProbe): string | undefined {
    if (!before.found || !after.found || before.offset === undefined || after.offset === undefined) return undefined;
    const name = after.component || before.component || "scroll view";
    const axis = after.horizontal ? "x" : "y";
    const of = after.maxOffset !== undefined ? ` of ${Math.round(after.maxOffset)}` : "";
    return `${name} ${axis} ${Math.round(before.offset)} → ${Math.round(after.offset)}${of}`;
}

/**
 * The swipe's outcome with the scroll line. When the list actually scrolled, the text
 * diff is rows a virtualized list mounted and unmounted, not changes, so it is dropped;
 * the scroll line says what happened.
 */
export function withScroll(outcome: ActionOutcome, before: ScrollProbe | null, after: ScrollProbe | null): ActionOutcome {
    if (!before || !after) return outcome;
    const scroll = formatScroll(before, after);
    if (!scroll) return outcome;
    const moved = before.offset !== after.offset;
    const { text, ...rest } = outcome;
    return moved ? { ...rest, scroll } : { ...outcome, scroll };
}

export function renderSwipeResponse(
    body: {
        verification?: TapVerification;
        outcome: ActionOutcome | null;
        warning?: string;
        foregroundLost?: string;
        staleBundle?: string;
        deviceNote?: string;
        platform: string;
        from: unknown;
        to: unknown;
        driverMessage?: string;
    },
    opts: { verbose: boolean; showDeviceNote: boolean }
): Record<string, unknown> {
    const out: Record<string, unknown> = { success: true };
    if (opts.verbose) Object.assign(out, { platform: body.platform, from: body.from, to: body.to });
    if (body.foregroundLost) out.foregroundLost = body.foregroundLost;
    if (body.staleBundle) out.staleBundle = body.staleBundle;
    if (opts.verbose && body.driverMessage) out.driverMessage = body.driverMessage;
    if (body.outcome && Object.keys(body.outcome).length > 0) out.outcome = body.outcome;
    if (body.verification) out.verification = opts.verbose ? body.verification : compactVerification(body.verification);
    if (body.warning) out.warning = body.warning;
    if (opts.showDeviceNote && body.deviceNote) out.deviceNote = body.deviceNote;
    return out;
}

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string };

/**
 * Puts the outcome into a tool response whose first content item is a JSON body (the
 * chromium swipe). A page that scrolled drops the text diff, as withScroll does on mobile.
 */
export function attachOutcome<R extends { content: ToolContent[]; isError?: boolean }>(response: R, outcome: ActionOutcome): R {
    const first = response.content[0];
    if (response.isError || !first || first.type !== "text" || !first.text) return response;
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(first.text);
    } catch {
        return response;
    }
    const scrolled = body.scrolled as { dx?: number; dy?: number } | undefined;
    const { text, ...rest } = outcome;
    const o = scrolled && (scrolled.dx || scrolled.dy) ? rest : outcome;
    if (Object.keys(o).length > 0) body.outcome = o;
    return { ...response, content: [{ ...first, text: JSON.stringify(body, null, 2) }, ...response.content.slice(1)] };
}
