/**
 * Failure artifacts for `input_text`, on the same rails as `tap`'s.
 *
 * A targeting miss reaches telemetry as a 200-character string with the
 * candidate list already truncated out of it, which is enough to count the
 * failure and not nearly enough to say why it happened. The three cases behind
 * it — the field was never there, the screen moved under the agent, the matcher
 * was too strict (core/screenStaleness.ts) — are only separable with the screen
 * in front of you and the FULL candidate list beside the predicate that missed.
 *
 * Deliberately reuses tap's bundle shape, upload path and R2 endpoint rather
 * than growing a parallel one: the fields map cleanly (inputs are the
 * "pressables" this tool can reach), and a second endpoint would duplicate the
 * upload, retention and dashboard-modal code for no new capability.
 */

import { captureFailureArtifact, type ArtifactOutcome, type CaptureSignals } from "./failureArtifact.js";
import type { InputCandidate } from "./inputTarget.js";
import { getServerVersion } from "./telemetry.js";
import { captureScreenshot } from "../pro/verifyAction.js";

export interface InputArtifactContext {
    outcome: ArtifactOutcome;
    platform: "ios" | "android";
    udid?: string;
    /** What the caller asked for, verbatim — the half of the story telemetry keeps. */
    predicate: Record<string, unknown>;
    errorMessage?: string;
    errorCategory?: string;
    /** Write path plus any staleness tag, e.g. `path=hid|screen_changed:inscreen`. */
    strategyChain?: string;
    /** Every input on screen when it missed — the half telemetry throws away. */
    candidates?: InputCandidate[];
    sent?: string;
    landed?: string | null;
}

/**
 * Uploads an artifact and returns the telemetry signals to hang off the result.
 *
 * Never throws and never blocks the tool: a diagnostic that can fail a write is
 * worse than no diagnostic.
 */
export async function captureInputArtifact(ctx: InputArtifactContext): Promise<CaptureSignals | undefined> {
    try {
        // A missing driver or a dead connection is a host problem, not an
        // input_text one, and its screenshot shows nothing — same exclusion tap
        // applies, for the same reason.
        if (ctx.errorCategory === "driver_missing" || ctx.errorCategory === "connection") {
            return undefined;
        }

        const shot = await captureScreenshot(ctx.platform, ctx.udid);

        const result = await captureFailureArtifact({
            outcome: ctx.outcome,
            predicate: {
                ...ctx.predicate,
                ...(ctx.sent !== undefined && { sent: ctx.sent }),
                ...(ctx.landed !== undefined && { landed: ctx.landed })
            },
            errorMessage: ctx.errorMessage,
            errorCategory: ctx.errorCategory,
            strategyChain: ctx.strategyChain,
            sessionId: "",
            version: getServerVersion(),
            senses: {
                // input_text resolves through fiber only — it never runs OCR or
                // reads the accessibility tree, and claiming otherwise would
                // make the dashboard's "fiber / a11y" column lie.
                ocr: { ran: false, durationMs: 0, detections: [], closestMatch: null },
                fiber: {
                    ran: true,
                    durationMs: 0,
                    metroConnected: true,
                    pressables: (ctx.candidates ?? []).map(c => ({
                        label: c.label ?? c.placeholder ?? undefined,
                        testID: c.testID ?? undefined,
                        componentName: c.component ?? undefined
                    }))
                },
                accessibility: { ran: false, durationMs: 0, elements: [] }
            },
            chosenTapPoint: null,
            chosenElement: null,
            screenshots: { before: shot?.buffer ?? null, afterWithMarker: null },
            deviceMeta: {
                platform: ctx.platform,
                screenSize: { w: shot?.width ?? 0, h: shot?.height ?? 0 }
            }
        });

        return result.signals;
    } catch {
        return undefined;
    }
}
