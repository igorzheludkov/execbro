import { executeInApp } from "./executor.js";
import type { ExecutionResult } from "./types.js";
import {
    buildClearFocusedInputExpression,
    buildDismissKeyboardExpression,
    type ClearFocusedInputResult,
    type DismissKeyboardResult
} from "./focusedInput.js";

export interface ClearFocusedInputToolResult {
    success: boolean;
    via?: "onChangeText" | "publicInstance";
    error?: string;
}

export interface DismissKeyboardToolResult {
    success: boolean;
    nativeTag?: number;
    error?: string;
}

export type ExecuteFn = (expression: string, device?: string) => Promise<ExecutionResult>;

const defaultExecute: ExecuteFn = (expression, device) => executeInApp(expression, true, {}, device);

function parseExecutorResult<T>(raw: string | undefined): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export async function clearFocusedInput(
    device?: string,
    execute: ExecuteFn = defaultExecute
): Promise<ClearFocusedInputToolResult> {
    const exec = await execute(buildClearFocusedInputExpression(), device);
    if (!exec.success) {
        return { success: false, error: exec.error ?? "executor failed" };
    }
    const r = parseExecutorResult<ClearFocusedInputResult>(exec.result);
    if (!r) {
        return { success: false, error: "could not parse executor result" };
    }
    if (r.cleared) {
        return { success: true, via: r.via };
    }
    return { success: false, error: r.reason };
}

export async function dismissKeyboard(
    device?: string,
    execute: ExecuteFn = defaultExecute
): Promise<DismissKeyboardToolResult> {
    const exec = await execute(buildDismissKeyboardExpression(), device);
    if (!exec.success) {
        return { success: false, error: exec.error ?? "executor failed" };
    }
    const r = parseExecutorResult<DismissKeyboardResult>(exec.result);
    if (!r) {
        return { success: false, error: "could not parse executor result" };
    }
    if (r.dismissed) {
        return { success: true, nativeTag: r.nativeTag };
    }
    return { success: false, error: r.reason };
}
