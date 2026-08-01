import { executeInApp } from "./executor.js";
import type { ExecutionResult } from "./types.js";
import { buildInputExpression, type InputOp, type InputQuery, type InputResult } from "./inputTarget.js";

export type ExecuteFn = (expression: string, device?: string) => Promise<ExecutionResult>;

const defaultExecute: ExecuteFn = (expression, device) =>
    executeInApp(expression, true, { originatingToolName: "input_text" }, device);

/**
 * Runs one resolver operation and normalises every failure — executor error,
 * unparseable output, app-side miss — into { found: false, reason }.
 *
 * Callers get exactly one shape to branch on and never have to catch, which is
 * what lets the orchestration above read as a straight line.
 */
export async function runInputOp(
    op: InputOp,
    query?: InputQuery,
    device?: string,
    execute: ExecuteFn = defaultExecute
): Promise<InputResult> {
    const exec = await execute(buildInputExpression(op, query), device);

    if (!exec.success) {
        return { found: false, reason: exec.error ?? "executor failed" };
    }

    try {
        return JSON.parse(exec.result ?? "") as InputResult;
    } catch {
        return {
            found: false,
            reason: `could not parse resolver output: ${String(exec.result).slice(0, 200)}`
        };
    }
}
