import { executeInApp } from "./jsExecute.js";
import type { ExecutionResult } from "./types.js";
import {
    buildReadRefreshLogExpression,
    type ReadRefreshLogRawResult,
    type RefreshLogEntry,
    type RecorderVia,
} from "./fastRefreshRecorder.js";

export type ExecuteFn = (
    expression: string,
    awaitPromise: boolean,
    options: Record<string, unknown>,
    device?: string,
) => Promise<ExecutionResult>;

const defaultExecute: ExecuteFn = (expression, awaitPromise, options, device) =>
    executeInApp(expression, awaitPromise, options, device);

export interface GetRefreshStatusArgs {
    sincePath?: string;
    since?: number;
    device?: string;
}

export interface GetRefreshStatusResult {
    success: boolean;
    lastUpdateAt?: number | null;
    updateCount?: number;
    recentUpdates?: RefreshLogEntry[];
    justInstalled?: boolean;
    via?: RecorderVia;
    error?: string;
}

function parseRawResult(raw: unknown): ReadRefreshLogRawResult | null {
    if (raw == null) return null;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw) as ReadRefreshLogRawResult;
        } catch {
            return null;
        }
    }
    if (typeof raw === "object") {
        return raw as ReadRefreshLogRawResult;
    }
    return null;
}

export async function getRefreshStatus(
    args: GetRefreshStatusArgs,
    execute: ExecuteFn = defaultExecute,
): Promise<GetRefreshStatusResult> {
    let expression: string;
    try {
        expression = buildReadRefreshLogExpression(args.sincePath, args.since);
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    const exec = await execute(expression, true, {}, args.device);
    if (!exec.success) {
        return { success: false, error: exec.error ?? "executor failed" };
    }

    const parsed = parseRawResult(exec.result);
    if (!parsed) {
        return { success: false, error: "could not parse executor result" };
    }

    const meta = parsed._meta;
    if (meta && meta.recorderInstalled === false) {
        return { success: false, error: meta.reason ?? "recorder not installed" };
    }

    return {
        success: true,
        lastUpdateAt: parsed.lastUpdateAt,
        updateCount: parsed.updateCount,
        recentUpdates: parsed.recentUpdates,
        justInstalled: meta?.justInstalled,
        via: meta?.via ?? null,
    };
}
