import { executeInApp } from "./executor.js";
import type { ExecutionResult } from "./types.js";
import {
    buildMeasureComponentExpression,
    type MeasureOutcome,
    type MeasureToolResult
} from "./measureComponent.js";

export type { MeasureOutcome, MeasureBounds, MeasureToolResult } from "./measureComponent.js";

export type ExecuteFn = (expression: string, device?: string) => Promise<ExecutionResult>;

const defaultExecute: ExecuteFn = (expression, device) =>
    executeInApp(expression, true, { timeoutMs: 5000, originatingToolName: "measure" }, device);

export async function measureComponent(
    componentName: string,
    index: number = 0,
    device?: string,
    execute: ExecuteFn = defaultExecute
): Promise<MeasureToolResult> {
    const safeIndex = typeof index === "number" && Number.isFinite(index) ? index : 0;
    const exec = await execute(buildMeasureComponentExpression(componentName, safeIndex), device);
    if (!exec.success) {
        return { success: false, outcome: "error", error: exec.error ?? "executor failed" };
    }
    let parsed: {
        outcome: MeasureOutcome;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        name?: string;
        nativeTag?: number;
        error?: string;
    } | null = null;
    try {
        parsed = exec.result ? JSON.parse(exec.result) : null;
    } catch {
        return { success: false, outcome: "error", error: "could not parse executor result" };
    }
    if (!parsed) {
        return { success: false, outcome: "error", error: "empty executor result" };
    }
    if (
        parsed.outcome === "measured" &&
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        typeof parsed.width === "number" &&
        typeof parsed.height === "number" &&
        typeof parsed.name === "string"
    ) {
        return {
            success: true,
            outcome: "measured",
            x: parsed.x,
            y: parsed.y,
            width: parsed.width,
            height: parsed.height,
            name: parsed.name,
            ...(typeof parsed.nativeTag === "number" ? { nativeTag: parsed.nativeTag } : {})
        };
    }
    return {
        success: false,
        outcome: parsed.outcome as Exclude<MeasureOutcome, "measured">,
        error: parsed.error ?? "unknown error"
    };
}
