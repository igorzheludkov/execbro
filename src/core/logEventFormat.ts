import type { LogEvent } from "./logEvents.js";

/** Only worth showing when the payload is big enough to matter. */
const SIZE_HINT_THRESHOLD = 4096;

function sizeHint(bytes: number): string {
    if (bytes < SIZE_HINT_THRESHOLD) return "";
    return ` [${(bytes / 1024).toFixed(1)} KB]`;
}

function frameHint(event: LogEvent): string {
    // The title already carries "(N frames)" for crashes it recognized.
    if (event.lineCount <= 1 || /\(\d+ frames\)/.test(event.title)) return "";
    return ` (${event.lineCount} lines)`;
}

export function formatEventRow(event: LogEvent, opts: { showDevice: boolean }): string {
    const time = event.ts.toLocaleTimeString();
    const cols = [`[${event.id}]`, time, event.level.toUpperCase()];
    if (opts.showDevice) cols.push(event.deviceName);
    if (event.owner) cols.push(event.owner);
    cols.push(event.title + frameHint(event) + sizeHint(event.byteSize));
    return cols.join("  ");
}

export function formatEventList(events: LogEvent[], opts: { showDevice: boolean }): string {
    if (events.length === 0) return "No log events.";
    return events.map((e) => formatEventRow(e, opts)).join("\n");
}

export function formatEventDetails(
    event: LogEvent,
    opts: { maxLength: number; verbose: boolean }
): string {
    const header = [
        `=== ${event.id} — ${event.kind.toUpperCase()} ===`,
        `Device: ${event.deviceName} (${event.deviceKey})`,
        `Time: ${event.ts.toISOString()}`,
        `Level: ${event.level.toUpperCase()}`,
        event.owner ? `Owner: ${event.owner}` : undefined,
        `Lines: ${event.lineCount}`,
        "",
    ].filter(Boolean).join("\n");

    const body = event.lines.map((l) => l.raw).join("\n");
    if (opts.verbose || opts.maxLength <= 0 || body.length <= opts.maxLength) {
        return header + body;
    }
    return `${header}${body.slice(0, opts.maxLength)}\n... [truncated: ${body.length} chars — pass verbose=true for the full payload]`;
}
