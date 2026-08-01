import { executeInApp } from "./executor.js";
import type { ExecutionResult } from "./types.js";
import { runInputOp } from "./inputTargetTools.js";

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

const defaultExecute: ExecuteFn = (expression, device) => executeInApp(expression, true, { originatingToolName: "focused_input" }, device);

export async function clearFocusedInput(
    device?: string,
    execute: ExecuteFn = defaultExecute
): Promise<ClearFocusedInputToolResult> {
    const r = await runInputOp({ kind: "clear" }, undefined, device, execute);
    if (!r.found) return { success: false, error: r.reason };
    if (!r.ok) return { success: false, error: r.via ?? "clear failed" };
    return { success: true, via: r.via === "publicInstance.clear" ? "publicInstance" : "onChangeText" };
}

export async function dismissKeyboard(
    device?: string,
    execute: ExecuteFn = defaultExecute
): Promise<DismissKeyboardToolResult> {
    const r = await runInputOp({ kind: "blur" }, undefined, device, execute);
    if (!r.found) return { success: false, error: r.reason };
    if (!r.ok) return { success: false, error: r.via ?? "blur failed" };
    return { success: true, nativeTag: r.nativeTag ?? undefined };
}

export interface TypeResult {
    success: boolean;
    result?: string;
    error?: string;
}

export async function inputTextWithReplace(
    text: string,
    replace: boolean,
    typeFn: (text: string) => Promise<TypeResult>,
    clearFn: () => Promise<ClearFocusedInputToolResult>
): Promise<TypeResult> {
    if (replace) {
        const clearResult = await clearFn();
        if (!clearResult.success) {
            return { success: false, error: clearResult.error };
        }
    }
    return typeFn(text);
}
