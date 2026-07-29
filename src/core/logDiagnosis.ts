import type { ConnectionCheckResult } from "./types.js";
// Type-only import: erased at compile time, so this adds no runtime edge to the
// connection module.
import type { LogPipelineResult } from "./connection.js";

/**
 * Why a log read came back with nothing.
 *
 * `no_logs_verified` vs `no_logs_unverified` is the important distinction:
 * `checkAndEnsureConnection` can report `connected: true` straight from the
 * passive socket state without touching the wire, so "the app printed nothing"
 * is only a claim we can stand behind once `verifyLogPipeline` has proven the
 * CDP console subscription is actually alive end to end. Everything else is
 * an unproven guess and must be labelled as such — otherwise a dead pipeline
 * is indistinguishable from a quiet app in telemetry.
 */
export type EmptyLogReason =
    | "disconnected"
    | "post_reconnect"
    | "pipeline_failed"
    | "pipeline_recovered"
    | "no_logs_verified"
    | "no_logs_unverified";

export interface LogDiagnosis {
    reason: EmptyLogReason;
    /** Human-readable warnings to append to the tool response. */
    warning: string;
    /** True when the pipeline was broken and recovery succeeded — caller should re-read the buffer. */
    recovered: boolean;
}

/**
 * Labels for the "connected, but nothing captured" verdict. Parameterised so
 * each tool reports in its own vocabulary (`no_logs_*` vs `no_requests_*`)
 * while sharing this logic.
 */
export interface EmptyDiagnosisLabels {
    /** Used only when a pipeline probe actually proved the capture path healthy. */
    verified: string;
    /** Used when no probe ran, or none exists for this data source. */
    unverified: string;
}

export interface EmptyDiagnosisDeps<TApp> {
    checkConnection: () => Promise<ConnectionCheckResult>;
    labels: EmptyDiagnosisLabels;
    /**
     * The app whose pipeline to verify, or null/undefined when none can be
     * resolved. Omit together with `verifyPipeline` for data sources that have
     * no end-to-end probe — the verdict then stays `unverified`, which is the
     * honest answer rather than a false clean bill of health.
     */
    resolveApp?: () => TApp | null | undefined;
    verifyPipeline?: (app: TApp) => Promise<LogPipelineResult>;
}

export interface EmptyDiagnosis {
    reason: string;
    warning: string;
    recovered: boolean;
}

export type LogDiagnosisDeps<TApp> = Omit<EmptyDiagnosisDeps<TApp>, "labels"> & {
    resolveApp: () => TApp | null | undefined;
    verifyPipeline: (app: TApp) => Promise<LogPipelineResult>;
};

/**
 * Diagnose why a buffer read returned zero entries.
 *
 * Shared by every empty-result path in `get_logs` and the network tools
 * (summary, SDK, and the plain buffer read) so that all of them report the
 * same reason for the same underlying state.
 */
export async function diagnoseEmptyResult<TApp>(deps: EmptyDiagnosisDeps<TApp>): Promise<EmptyDiagnosis> {
    const status = await deps.checkConnection();
    let warning = status.message ? `\n\n${status.message}` : "";

    if (!status.connected) {
        return { reason: "disconnected", warning, recovered: false };
    }

    // Connected — but by the passive check, which proves nothing about the
    // capture subscription. Start pessimistic and let the pipeline probe
    // upgrade the verdict.
    let reason: string = status.wasReconnected ? "post_reconnect" : deps.labels.unverified;
    let recovered = false;

    const app = deps.resolveApp?.();
    if (app && deps.verifyPipeline) {
        const pipeline = await deps.verifyPipeline(app);
        if (pipeline.message) {
            warning += `\n\n${pipeline.message}`;
        }
        if (!pipeline.ok) {
            reason = "pipeline_failed";
        } else if (pipeline.recovered) {
            reason = "pipeline_recovered";
            recovered = true;
        } else if (reason === deps.labels.unverified) {
            // Probe round-tripped: the pipeline is provably healthy, so an
            // empty buffer really does mean the app produced nothing.
            reason = deps.labels.verified;
        }
        // A healthy pipeline does not erase `post_reconnect` — the reconnect is
        // still the reason earlier data is missing.
    }

    return { reason, warning, recovered };
}

export const LOG_EMPTY_LABELS: EmptyDiagnosisLabels = {
    verified: "no_logs_verified",
    unverified: "no_logs_unverified"
};

/** `diagnoseEmptyResult` bound to the log vocabulary. */
export async function diagnoseEmptyLogs<TApp>(deps: LogDiagnosisDeps<TApp>): Promise<LogDiagnosis> {
    const result = await diagnoseEmptyResult({ ...deps, labels: LOG_EMPTY_LABELS });
    return { ...result, reason: result.reason as EmptyLogReason };
}
