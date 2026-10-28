/**
 * What the agent did to the app, in order. Filled at the tool chokepoint for
 * tools that change state, read by get_timeline to answer "what did my last
 * action cause". Targets only: a value the agent typed can be a password, and
 * this log outlives the call that carried it.
 */

import { redactSecrets, redactionEnabled } from "./redact.js";

export interface ActionEntry {
    tool: string;
    device: string | null;
    startedAt: number;
    endedAt: number;
    ok: boolean;
    summary: string;
    outcome?: string;
}

export interface ActionInput {
    tool: string;
    args: unknown;
    startedAt: number;
    endedAt: number;
    ok: boolean;
    error?: string;
    meaningful?: boolean;
}

export const ACTION_TOOLS: ReadonlySet<string> = new Set([
    "tap", "swipe", "pinch", "input_text", "press_key", "navigate", "dismiss_keyboard",
    "handle_dialog", "ios_button", "android_key_event", "android_long_press", "ios_open_url",
    "reload_app", "ios_launch_app", "android_launch_app", "electron_launch_app", "ios_terminate_app",
    "network_mock", "network_condition", "redux_dispatch", "execute_in_app", "app_request", "network_replay",
]);

const CAP = 200;
let entries: ActionEntry[] = [];

function str(v: unknown): string | undefined {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Redacted before cutting: the output chokepoint redacts again, but a token cut
// in half no longer matches its pattern there.
function cut(s: string, max: number): string {
    const one = (redactionEnabled() ? redactSecrets(s) : s).replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
}

function pathOf(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname + u.search;
    } catch {
        return url;
    }
}

export function summarizeArgs(tool: string, args: unknown): string {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    switch (tool) {
        case "tap": {
            const x = num(a.x), y = num(a.y);
            const target = str(a.testID) ? `testID=${a.testID}`
                : str(a.text) ? `text=${JSON.stringify(cut(a.text as string, 40))}`
                : str(a.component) ? `component=${a.component}`
                : x !== undefined && y !== undefined ? `(${x},${y})` : "";
            const hold = num(a.duration) ? ` hold ${a.duration}ms` : "";
            return `${target}${hold}`;
        }
        case "swipe":
            return str(a.direction) ?? `(${a.startX},${a.startY})→(${a.endX},${a.endY})`;
        case "pinch":
            return [str(a.direction), num(a.scale) !== undefined ? `scale ${a.scale}` : undefined].filter(Boolean).join(" ");
        case "input_text": {
            const target = str(a.testID) ? `testID=${a.testID}`
                : str(a.component) ? `component=${a.component}`
                : str(a.textMatch) ? `field ${JSON.stringify(cut(a.textMatch as string, 40))}`
                : "focused field";
            const n = typeof a.text === "string" ? a.text.length : 0;
            return `${target} ${n} chars${a.replace === true ? " replace" : ""}`;
        }
        case "press_key":
            return `${str(a.key) ?? ""}${num(a.repeat) && (a.repeat as number) > 1 ? ` ×${a.repeat}` : ""}`;
        case "navigate":
            return str(a.to) ?? str(a.screen) ?? "";
        case "execute_in_app":
            return cut(str(a.expression) ?? str(a.code) ?? str(a.script) ?? str(a.collect) ?? "", 60);
        case "network_mock":
            return [str(a.action), str(a.url) ?? str(a.id)].filter(Boolean).join(" ");
        case "network_condition":
            return str(a.mode) ?? "";
        case "redux_dispatch": {
            const list = Array.isArray(a.action) ? a.action : [a.action];
            return list.map((x) => (x && typeof x === "object" ? str((x as Record<string, unknown>).type) : undefined))
                .filter(Boolean).join(", ");
        }
        case "app_request":
            return `${str(a.method) ?? "GET"} ${str(a.url) ? pathOf(a.url as string) : ""}`.trim();
        case "network_replay":
            return str(a.requestId) ? `request ${a.requestId}` : "";
        case "ios_open_url":
            return str(a.url) ? cut(a.url as string, 60) : "";
        case "ios_button":
            return str(a.button) ?? "";
        case "android_key_event":
            return str(a.key) ?? "";
        case "android_long_press":
            return `(${a.x},${a.y})`;
        case "handle_dialog":
            return str(a.action) ?? "";
        case "ios_launch_app":
        case "ios_terminate_app":
            return str(a.bundleId) ?? "";
        case "android_launch_app":
            return str(a.packageName) ?? "";
        case "electron_launch_app":
            return str(a.projectPath)?.split("/").filter(Boolean).pop() ?? "";
        default:
            return "";
    }
}

export function recordAction(input: ActionInput): void {
    try {
        if (!ACTION_TOOLS.has(input.tool)) return;
        const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>;
        const outcome = !input.ok
            ? cut(input.error ?? "error", 80).replace(/…$/, "")
            : input.meaningful === true ? "screen changed"
            : input.meaningful === false ? "no visible change"
            : undefined;
        entries.push({
            tool: input.tool,
            device: str(args.device) ?? null,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            ok: input.ok,
            summary: summarizeArgs(input.tool, args),
            outcome,
        });
        if (entries.length > CAP) entries.shift();
    } catch {
        // The timeline is a convenience; the tool call it describes is not.
    }
}

export function getActions(): ActionEntry[] {
    return [...entries];
}

export function deviceMatches(entryDevice: string | null, key: string): boolean {
    if (!entryDevice) return true;
    const a = entryDevice.toLowerCase(), b = key.toLowerCase();
    return a.includes(b) || b.includes(a);
}

/**
 * The action get_timeline's default window starts at. execute_in_app is logged
 * but never anchors while another action exists: agents mostly use it to read
 * state, and tap -> read -> get_timeline must still show what the tap caused.
 */
export function lastAction(device?: string): ActionEntry | null {
    let fallback: ActionEntry | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (device && !deviceMatches(entries[i].device, device)) continue;
        if (entries[i].tool !== "execute_in_app") return entries[i];
        fallback ??= entries[i];
    }
    return fallback;
}

export function actionLabel(a: ActionEntry): string {
    return a.summary ? `${a.tool} ${a.summary}` : a.tool;
}

export function resetActionLog(): void {
    entries = [];
}
