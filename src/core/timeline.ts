/**
 * get_timeline's model: which window, which events, what survives the limit,
 * and how it reads. Pure: every input arrives as data, so the ordering and
 * trimming rules are testable without a device. Collection lives in
 * timelineSources.ts.
 */

import { UserInputError } from "./errors.js";
import { actionLabel, type ActionEntry } from "./actionLog.js";
import type { LogEntry, NetworkRequest } from "./types.js";
import type { RefreshLogEntry } from "./fastRefreshRecorder.js";

// perf is reserved: accepted now, filled by route render cost and measure_startup.
export const TIMELINE_SOURCES = ["actions", "routes", "network", "logs", "restarts", "refresh", "perf"] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];
export type EventKind = "restart" | "action" | "route" | "perf" | "request" | "log" | "refresh";

export interface TimelineEvent {
    at: number;
    kind: EventKind;
    source: TimelineSource;
    device: string;
    /** Lower survives the limit first. */
    tier: number;
    text: string;
    ids?: { log?: string; request?: string };
}

export interface TimelineWindow {
    start: number;
    end: number;
    label: string;
    fallback: boolean;
}

export const FALLBACK_WINDOW_MS = 60_000;

const KIND_ORDER: Record<EventKind, number> = { restart: 0, action: 1, route: 2, perf: 3, request: 4, log: 5, refresh: 6 };
const TIER = { restart: 0, action: 1, route: 2, perf: 2, refresh: 3, errorLog: 4, failedRequest: 5, warnLog: 6, request: 7, log: 8 };
const RELATIVE = /^-(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const FORMATS = 'epoch ms, a relative time like "-30s", "-5m" or "-1h"';

function parseBound(value: string | number, now: number, name: "since" | "until"): number {
    if (typeof value === "number") {
        if (Number.isFinite(value) && value > 0) return value;
    } else {
        const v = value.trim();
        if (/^\d+$/.test(v)) return Number(v);
        const m = RELATIVE.exec(v);
        if (m) return now - Number(m[1]) * UNIT_MS[m[2]];
    }
    const extra = name === "since" ? ', or "last_action"' : "";
    throw new UserInputError(`${name} must be ${FORMATS}${extra}. Got ${JSON.stringify(value)}.`);
}

function clockLabel(ms: number): string {
    return new Date(ms).toISOString().slice(11, 23);
}

export function resolveWindow(opts: { since?: string | number; until?: string | number; now: number; lastAction: ActionEntry | null }): TimelineWindow {
    const end = opts.until === undefined ? opts.now : parseBound(opts.until, opts.now, "until");
    const since = opts.since ?? "last_action";
    if (since === "last_action") {
        if (opts.lastAction) {
            return { start: opts.lastAction.startedAt, end, label: `▶ ${actionLabel(opts.lastAction)}`, fallback: false };
        }
        return { start: end - FALLBACK_WINDOW_MS, end, label: "-60s", fallback: true };
    }
    const start = parseBound(since, opts.now, "since");
    if (start > end) throw new UserInputError(`since (${clockLabel(start)}) is after until (${clockLabel(end)}).`);
    const label = typeof since === "string" && since.trim().startsWith("-") ? since.trim() : clockLabel(start);
    return { start, end, label, fallback: false };
}

function oneLine(s: string, max: number): string {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function hostOf(url: string): string | null {
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

function displayUrl(url: string, showHost: boolean): string {
    try {
        const u = new URL(url);
        return oneLine(`${showHost ? u.host : ""}${u.pathname}${u.search}`, 80);
    } catch {
        return oneLine(url, 80);
    }
}

export function actionEvent(a: ActionEntry, device: string): TimelineEvent {
    const result = a.ok ? (a.outcome ? `ok, ${a.outcome}` : "ok") : `failed: ${a.outcome ?? "error"}`;
    return { at: a.startedAt, kind: "action", source: "actions", device, tier: TIER.action, text: `▶ ${actionLabel(a)} → ${result}` };
}

export function logEvent(e: LogEntry, device: string): TimelineEvent {
    const severe = e.level === "error" || e.level === "fatal";
    const mark = severe ? "✖" : e.level === "warn" ? "⚠" : "·";
    const tier = severe ? TIER.errorLog : e.level === "warn" ? TIER.warnLog : TIER.log;
    const id = `j${e.seq}`;
    return {
        at: e.timestamp.getTime(), kind: "log", source: "logs", device, tier,
        text: `${mark} ${e.level} ${JSON.stringify(oneLine(e.message, 120))}  [${id}]`,
        ids: { log: id },
    };
}

export function requestEvent(r: NetworkRequest, device: string, showHost: boolean): TimelineEvent {
    const failed = !!r.error || (r.status !== undefined && r.status >= 400);
    const duration = r.timing?.duration !== undefined ? ` · ${Math.round(r.timing.duration)}ms` : "";
    const outcome = r.error ? `failed: ${oneLine(r.error, 60)}`
        : r.status === undefined ? (r.completed ? "no status" : "pending")
        : `${r.status}${duration}`;
    return {
        at: r.timestamp.getTime(), kind: "request", source: "network", device,
        tier: failed ? TIER.failedRequest : TIER.request,
        text: `⇄ ${r.mocked ? "[MOCK] " : ""}${r.method} ${displayUrl(r.url, showHost)} ${outcome}  [n${r.requestId}]`,
        ids: { request: r.requestId },
    };
}

export function routeEvent(v: { route: string; from: string | null; at: number }, device: string): TimelineEvent {
    return { at: v.at, kind: "route", source: "routes", device, tier: TIER.route, text: `➜ route ${v.route}${v.from ? ` (from ${v.from})` : ""}` };
}

export function restartEvent(epoch: number, at: number, device: string): TimelineEvent {
    return { at, kind: "restart", source: "restarts", device, tier: TIER.restart, text: `⟳ app restarted (epoch ${epoch})` };
}

export function refreshEvent(u: RefreshLogEntry, at: number, device: string): TimelineEvent {
    const file = u.modulePath?.split("/").filter(Boolean).pop();
    return { at, kind: "refresh", source: "refresh", device, tier: TIER.refresh, text: file ? `↻ edit applied: ${file}` : "↻ edit applied (Fast Refresh)" };
}

export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
    return [...events].sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export function trimEvents(events: TimelineEvent[], limit: number): { kept: TimelineEvent[]; dropped: Partial<Record<TimelineSource, number>> } {
    if (events.length <= limit) return { kept: sortEvents(events), dropped: {} };
    const byPriority = [...events].sort((a, b) => a.tier - b.tier || a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const dropped: Partial<Record<TimelineSource, number>> = {};
    for (const e of byPriority.slice(limit)) dropped[e.source] = (dropped[e.source] ?? 0) + 1;
    return { kept: sortEvents(byPriority.slice(0, limit)), dropped };
}

function formatSpan(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    return `${m}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function formatRelative(ms: number): string {
    return `+${formatSpan(ms)}`;
}

export interface FormatInput {
    window: TimelineWindow;
    deviceLabel: string;
    events: TimelineEvent[];
    tagDevices: boolean;
    dropped: Partial<Record<TimelineSource, number>>;
    notes: string[];
    checked: TimelineSource[];
}

export function formatTimeline(input: FormatInput): string {
    const { window, deviceLabel, events, tagDevices, dropped, notes, checked } = input;
    const span = formatSpan(window.end - window.start);
    if (events.length === 0) {
        const lines = [`Nothing happened in the ${span} since ${window.label} on ${deviceLabel}${checked.length ? ` (checked: ${checked.join(", ")})` : ""}.`];
        if (checked.includes("logs")) lines.push("Log capture is not re-verified by this read; if you expected output, get_logs checks the pipeline.");
        return [...lines, ...notes].join("\n");
    }
    const lines = [`Timeline (${deviceLabel}) since ${window.label} · ${span} · ${events.length} event${events.length === 1 ? "" : "s"}`];
    for (const e of events) {
        lines.push(`${formatRelative(e.at - window.start).padEnd(8)}${tagDevices ? `[${e.device}] ` : ""}${e.text}`);
    }
    const footer: string[] = [];
    const droppedParts = Object.entries(dropped).map(([s, n]) => `${s} ${n}`);
    if (droppedParts.length) footer.push(`Over the limit, omitted: ${droppedParts.join(", ")}. Narrow with sources or until, or raise limit.`);
    const logId = events.find((e) => e.ids?.log)?.ids?.log;
    const reqId = events.find((e) => e.ids?.request)?.ids?.request;
    const hints = [
        logId ? `get_log_details({ id: "${logId}" })` : "",
        reqId ? `get_request_details({ requestId: "${reqId}" })` : "",
    ].filter(Boolean);
    if (hints.length) footer.push(`Details: ${hints.join(", ")}. Request ids drop the n.`);
    footer.push(...notes);
    return footer.length ? `${lines.join("\n")}\n\n${footer.join("\n")}` : lines.join("\n");
}
