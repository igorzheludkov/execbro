/**
 * Tool-level behaviour for native Android apps (execbro-sdk-android). The
 * tools keep their names; for a runtime "native" target they come here
 * instead of evaluating JavaScript.
 */

import type { ConnectedApp } from "./types.js";
import { nativeRequest, NativeRpcError } from "./nativeConnection.js";

export type NativeResult = { success: boolean; result?: string; error?: string };

interface CommandInfo {
    name: string;
    description: string;
}

function describeNativeError(e: unknown): string {
    if (e instanceof NativeRpcError) return `${e.code}: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
}

function commandLine(c: CommandInfo, indent: string): string {
    return `${indent}- ${c.name}${c.description ? `: ${c.description}` : ""}`;
}

export async function nativeListDebugGlobals(app: ConnectedApp): Promise<NativeResult> {
    try {
        const [states, commands] = await Promise.all([
            nativeRequest<Array<{ name: string }>>(app.ws, "state.list"),
            nativeRequest<CommandInfo[]>(app.ws, "command.list")
        ]);
        const lines = [
            `Native Android app ${app.deviceInfo.deviceName} (${app.nativePackage}), via execbro-sdk-android.`,
            "",
            "State (read with inspect_global({ objectName })):",
            ...(states.length > 0 ? states.map((s) => `  - ${s.name}`) : ["  (none registered)"]),
            "",
            "Commands (run with run_app_command({ name, args })):",
            ...(commands.length > 0 ? commands.map((c) => commandLine(c, "  ")) : ["  (none registered)"])
        ];
        return { success: true, result: lines.join("\n") };
    } catch (e) {
        return { success: false, error: describeNativeError(e) };
    }
}

export async function nativeInspectGlobal(app: ConnectedApp, name: string): Promise<NativeResult> {
    try {
        const r = await nativeRequest<{ value: unknown }>(app.ws, "state.get", { name });
        return { success: true, result: JSON.stringify(r.value, null, 2) };
    } catch (e) {
        return { success: false, error: describeNativeError(e) };
    }
}

export async function nativeRunCommand(app: ConnectedApp, name?: string, args?: Record<string, unknown>): Promise<NativeResult> {
    try {
        if (!name) {
            const commands = await nativeRequest<CommandInfo[]>(app.ws, "command.list");
            return { success: true, result: commands.length > 0 ? commands.map((c) => commandLine(c, "")).join("\n") : "(no commands registered)" };
        }
        const r = await nativeRequest<{ result: unknown }>(app.ws, "command.run", args ? { name, args } : { name });
        return { success: true, result: `${name} -> ${JSON.stringify(r.result)}` };
    } catch (e) {
        return { success: false, error: describeNativeError(e) };
    }
}
