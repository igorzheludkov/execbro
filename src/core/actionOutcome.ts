/**
 * What an action (tap, swipe) did to the app, in app terms: route before and after,
 * text that changed on screen, requests, console errors, restarts. Pure: collection
 * lives in actionOutcomeCollect.ts.
 *
 * Merged by time only, like get_timeline. Nothing here claims the action caused an
 * event; "during this tap" is the strongest wording allowed.
 */

import type { ScreenState, ScreenStatePressable } from "./screenState.js";
import { TIER, type TimelineEvent } from "./timeline.js";

export interface SnapshotItem {
    text: string;
    x: number;
    y: number;
}

export interface OutcomeSnapshot {
    route: string | null;
    items: SnapshotItem[];
}

export interface ActionOutcome {
    route?: string;
    text?: string[];
    network?: string[];
    console?: string[];
    restart?: string;
    scroll?: string;
    pending?: string;
    unavailable?: string[];
}

export const TEXT_DIFF_CAP = 10;
const TEXT_MAX = 80;
/** Two texts this close vertically are the same line changing, not one leaving and one arriving. */
const PAIR_DY = 16;
const NEW_SCREEN = "new screen (route changed): get_screen_state reads it";

function clip(s: string): string {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX)}…` : flat;
}

function pressableText(p: ScreenStatePressable): string | null {
    if (p.isInput) {
        const name = p.inputPlaceholder || p.label || p.testID || "input";
        return `${name}: ${p.inputValue ?? "(empty)"}`;
    }
    if (p.switchValue != null) return `[switch:${p.switchValue ? "ON" : "OFF"}] ${p.label ?? p.testID ?? ""}`.trim();
    return p.label ?? null;
}

export function snapshotFromScreenState(ss: ScreenState): OutcomeSnapshot {
    const items: SnapshotItem[] = [];
    const add = (text: string | null | undefined, c: { x: number; y: number }) => {
        if (text) items.push({ text: clip(text), x: c.x, y: c.y });
    };
    const groups = [{ pressables: ss.pressables, texts: ss.texts }, ...ss.overlays.map((o) => ({ pressables: o.pressables, texts: o.texts ?? [] }))];
    for (const g of groups) {
        for (const t of g.texts) add(t.text, t.center);
        for (const p of g.pressables) add(pressableText(p), p.center);
    }
    return { route: ss.route?.name ?? null, items };
}

export function diffSnapshots(before: OutcomeSnapshot, after: OutcomeSnapshot, cap: number = TEXT_DIFF_CAP): string[] {
    // Multiset difference by text: what only one side has.
    const counts = new Map<string, number>();
    for (const i of before.items) counts.set(i.text, (counts.get(i.text) ?? 0) + 1);
    const added: SnapshotItem[] = [];
    for (const i of after.items) {
        const n = counts.get(i.text) ?? 0;
        if (n > 0) counts.set(i.text, n - 1);
        else added.push(i);
    }
    const left = new Map<string, number>();
    for (const i of after.items) left.set(i.text, (left.get(i.text) ?? 0) + 1);
    const removed: SnapshotItem[] = [];
    for (const i of before.items) {
        const n = left.get(i.text) ?? 0;
        if (n > 0) left.set(i.text, n - 1);
        else removed.push(i);
    }

    const lines: Array<{ y: number; line: string }> = [];
    const free = new Set(added);
    for (const r of removed) {
        let best: SnapshotItem | null = null;
        for (const a of free) {
            const dy = Math.abs(a.y - r.y);
            if (dy <= PAIR_DY && (!best || dy < Math.abs(best.y - r.y))) best = a;
        }
        if (best) {
            free.delete(best);
            lines.push({ y: best.y, line: `"${r.text}" → "${best.text}"` });
        } else {
            lines.push({ y: r.y, line: `- "${r.text}"` });
        }
    }
    for (const a of free) lines.push({ y: a.y, line: `+ "${a.text}"` });
    lines.sort((a, b) => a.y - b.y);

    const out = lines.map((l) => l.line);
    return out.length > cap ? [...out.slice(0, cap), `+${out.length - cap} more, get_screen_state for all`] : out;
}

export function buildOutcome(input: {
    before: OutcomeSnapshot | null;
    after: OutcomeSnapshot | null;
    events: TimelineEvent[];
    pending: number;
    capped: boolean;
    unavailable: string[];
}): ActionOutcome {
    const { before, after, events, pending, capped, unavailable } = input;
    const o: ActionOutcome = {};

    if (before && after) {
        const routeChanged = before.route !== after.route;
        if (before.route || after.route) {
            o.route = routeChanged ? `${before.route ?? "?"} → ${after.route ?? "?"}` : `unchanged (${after.route})`;
        }
        if (routeChanged) {
            o.text = [NEW_SCREEN];
        } else {
            const diff = diffSnapshots(before, after);
            if (diff.length) o.text = diff;
        }
    }

    const network = events.filter((e) => e.kind === "request").map((e) => e.text);
    const console = events.filter((e) => e.kind === "log" && (e.tier === TIER.errorLog || e.tier === TIER.warnLog)).map((e) => e.text);
    const restart = events.find((e) => e.kind === "restart");
    if (network.length) o.network = network;
    if (console.length) o.console = console;
    if (restart) o.restart = restart.text;
    if (capped && pending > 0) o.pending = `${pending} request(s) still in flight after 3s: get_timeline() shows the rest`;
    if (unavailable.length) o.unavailable = unavailable;
    return o;
}
