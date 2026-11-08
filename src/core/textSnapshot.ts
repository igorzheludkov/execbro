/**
 * The text an action's outcome compares before and after: every visible line of text,
 * input value (masked) and switch value, in tree order, plus the current route. One
 * Runtime.evaluate and no measureInWindow, because get_screen_state's measurement wait
 * cost ~870ms per read on a Pixel 9 emulator, twice per tap. Tree order stands in for
 * position: a line that changes keeps its place in the tree.
 */

import { VISIBILITY_HELPERS_JS } from "./injected/visibility.js";
import { SECURE_VALUE_JS } from "./injected/secureValue.js";
import { buildNavHandlesSource, buildRouteTableSource } from "./navigation.js";
import { executeInApp } from "./jsExecute.js";
import { snapshotFromLines, type OutcomeSnapshot } from "./actionOutcome.js";

/* eslint-disable no-var */
declare var isLogBoxSubtree: (name: string | null) => boolean;
declare var isHiddenNavigationScene: (name: string | null, props: unknown) => boolean;
declare var maskSecureValue: (props: unknown, value: unknown) => unknown;

/**
 * Self-contained: injected with toString(), and relies only on the helpers in
 * TEXT_SNAPSHOT_HELPERS_JS being in scope.
 */
export function walkTextSnapshot(root: any): string[] {
    var out: string[] = [];
    function nameOf(f: any): string | null {
        if (!f || !f.type) return null;
        if (typeof f.type === "string") return f.type;
        return f.type.displayName || f.type.name || null;
    }
    function rawText(f: any, d: number): string {
        if (!f || d > 50) return "";
        // A HostText fiber has type null and carries the raw string as its props.
        var p = f.memoizedProps;
        var s = typeof p === "string" || typeof p === "number" ? String(p) : "";
        var c = f.child;
        while (c) {
            s += rawText(c, d + 1);
            c = c.sibling;
        }
        return s;
    }
    function visit(f: any, d: number): void {
        if (!f || d > 5000) return;
        var name = nameOf(f);
        var p = f.memoizedProps || {};
        if (isLogBoxSubtree(name) || isHiddenNavigationScene(name, p)) return;
        if (typeof p.onChangeText === "function") {
            var label = p.placeholder || p.accessibilityLabel || p.testID || "input";
            var v = typeof p.value === "string" && p.value.length > 0 ? maskSecureValue(p, p.value)
                : typeof p.defaultValue === "string" && p.defaultValue.length > 0 ? maskSecureValue(p, p.defaultValue)
                : null;
            out.push(label + ": " + (v === null ? "(empty)" : v));
            return;
        }
        if (typeof p.onValueChange === "function" && typeof p.value === "boolean") {
            out.push(("[switch:" + (p.value ? "ON" : "OFF") + "] " + (p.accessibilityLabel || p.testID || "")).trim());
            return;
        }
        if (name === "RCTText") {
            var t = rawText(f, 0).replace(/\s+/g, " ").trim();
            if (t) out.push(t);
            return;
        }
        var c = f.child;
        while (c) {
            visit(c, d + 1);
            c = c.sibling;
        }
    }
    visit(root, 0);
    return out;
}

export const TEXT_SNAPSHOT_HELPERS_JS = `${VISIBILITY_HELPERS_JS}\n${SECURE_VALUE_JS}`;

export function buildTextSnapshotExpression(): string {
    return `(function(){
${buildNavHandlesSource()}
${buildRouteTableSource()}
${TEXT_SNAPSHOT_HELPERS_JS}
var walk = ${walkTextSnapshot.toString()};
var roots = __eb_fiberRoots(false);
var lines = [];
for (var ri = 0; ri < roots.length; ri++) lines = lines.concat(walk(roots[ri].current));
var route = null;
try { route = __eb_routeTable().current; } catch (e) {}
return JSON.stringify({ route: route, lines: lines });
})()`;
}

/** Bounded like get_timeline's reads: no retry, no reconnect, 3s. */
export async function readTextSnapshot(device: string): Promise<OutcomeSnapshot> {
    const r = await executeInApp(buildTextSnapshotExpression(), false, {
        timeoutMs: 3000, maxRetries: 0, autoReconnect: false, originatingToolName: "action_outcome",
    }, device);
    if (!r.success || typeof r.result !== "string") throw new Error(r.error ?? "text snapshot read failed");
    const parsed = JSON.parse(r.result) as { route: string | null; lines: string[] };
    return snapshotFromLines(parsed.route, parsed.lines);
}
