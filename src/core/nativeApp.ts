/**
 * Tool-level behaviour for native Android apps (execbro-sdk-android). The
 * tools keep their names; for a runtime "native" target they come here
 * instead of evaluating JavaScript.
 */

import type { ConnectedApp } from "./types.js";
import { nativeRequest, NativeRpcError } from "./nativeConnection.js";
import type { NavigationResult, PerformNavigationOptions } from "./navigate.js";

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

interface NavSnapshot {
    route: string | null;
    arguments: Record<string, unknown>;
    backStack: Array<string | null>;
}

const compactStack = (s: Array<string | null>): string[] => s.filter((r): r is string => !!r);
const positionKey = (s: NavSnapshot): string => JSON.stringify([s.backStack, s.arguments]);

/**
 * navigate for a Jetpack Navigation app. NavController updates its back stack
 * synchronously, so the SDK's before/after is already settled: no polling.
 */
export async function nativeNavigate(app: ConnectedApp, opts: PerformNavigationOptions): Promise<NavigationResult> {
    const { action, to = null, params, includeRouteTable } = opts;
    const base = { kind: "jetpack-navigation", action, to };
    try {
        const routeTable = includeRouteTable
            ? (await nativeRequest<{ destinations: Array<{ route: string | null }> }>(app.ws, "nav.routes")).destinations
                .map((d) => d.route)
                .filter((r): r is string => !!r)
            : undefined;
        if (!to && action !== "back" && action !== "reset") {
            const current = await nativeRequest<NavSnapshot>(app.ws, "nav.current");
            const position = { before: current.route, after: current.route };
            if (routeTable) {
                return { success: true, ...base, route: position, changed: false, indeterminate: false, stack: compactStack(current.backStack), routeTable };
            }
            return {
                success: false, ...base, route: position, changed: false, indeterminate: false,
                error: `'to' is required for action '${action}'. Call navigate({ routeTable: true }) to list the routes.`
            };
        }
        const r = await nativeRequest<{ before: NavSnapshot; after: NavSnapshot }>(app.ws, "nav.navigate", {
            action,
            ...(to ? { to } : {}),
            ...(params ? { params } : {})
        });
        return {
            success: true, ...base,
            route: { before: r.before.route, after: r.after.route },
            changed: positionKey(r.before) !== positionKey(r.after),
            indeterminate: false,
            stack: compactStack(r.after.backStack),
            ...(routeTable ? { routeTable } : {})
        };
    } catch (e) {
        return { success: false, ...base, route: { before: null, after: null }, changed: false, indeterminate: false, error: describeNativeError(e) };
    }
}
