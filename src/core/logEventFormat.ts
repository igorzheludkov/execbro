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

export interface RowOptions {
    showDevice: boolean;
    /** Truncation budget for message-kind rows. 0 or verbose disables it. */
    maxLength?: number;
    verbose?: boolean;
}

/**
 * A message event carries no summary worth substituting for its content — it
 * IS the content. Truncating it to a title would silently break get_logs'
 * documented verbose / maxMessageLength contract, which promises full
 * messages on request.
 */
function messageBody(event: LogEvent, opts: RowOptions): string {
    // `message`, not `raw`: raw carries the logcat epoch/pid/tid/priority/tag
    // prefix, all of which the row already renders as its own columns. `raw`
    // belongs in the detail view (formatEventDetails), where byte-fidelity is
    // the point.
    const body = event.lines.map((l) => l.message).join("\n");
    const budget = opts.maxLength ?? 500;
    return opts.verbose || budget <= 0 || body.length <= budget
        ? body
        : `${body.slice(0, budget)}... [truncated: ${body.length} chars]`;
}

export function formatEventRow(event: LogEvent, opts: RowOptions): string {
    const time = event.ts.toLocaleTimeString();
    const cols = [`[${event.id}]`, time, event.level.toUpperCase()];
    if (opts.showDevice) cols.push(event.deviceName);
    if (event.owner) cols.push(event.owner);
    // Compactness matters for crashes/ANRs/exceptions — they keep the
    // one-line title, and get_log_details exists to expand them. Fidelity
    // matters for plain messages, which have no separate summary.
    //
    // Under verbose, a JS event must render its real payload: `exception`
    // events carry the stack an agent asked for, and titleFor() would drop it.
    // Native crash rows stay compact even here — get_log_details is their
    // documented expansion path, and one verbose call should not dump every
    // backtrace on the device.
    const rendersBody = event.kind === "message" || (opts.verbose === true && event.source === "js");
    const text = rendersBody
        ? messageBody(event, opts)
        : event.title + frameHint(event) + sizeHint(event.byteSize);
    cols.push(text);
    return cols.join("  ");
}

export function formatEventList(events: LogEvent[], opts: RowOptions): string {
    if (events.length === 0) return "No log events.";
    return events.map((e) => formatEventRow(e, opts)).join("\n");
}

export function formatEventDetails(
    event: LogEvent,
    opts: { maxLength: number; verbose: boolean }
): string {
    const headerLines: Array<string | undefined> = [
        `=== ${event.id} — ${event.kind.toUpperCase()} ===`,
        `Device: ${event.deviceName} (${event.deviceKey})`,
        `Time: ${event.ts.toISOString()}`,
        `Level: ${event.level.toUpperCase()}`,
        event.owner ? `Owner: ${event.owner}` : undefined,
        `Lines: ${event.lineCount}`,
        "",
    ];
    // filter(Boolean) would also drop the trailing "" blank-line separator —
    // it's falsy, same as an absent optional field — running the header
    // straight into the payload. Only drop lines that are genuinely absent.
    //
    // Array#join only inserts its separator BETWEEN elements, so a single
    // trailing "" contributes one "\n" (ending the last real line), not a
    // blank row — join(["Lines: 39", ""], "\n") is "Lines: 39\n", not
    // "Lines: 39\n\n". The explicit "\n" below supplies the second newline
    // that actually produces the blank line before the payload.
    const header = headerLines.filter((line) => line !== undefined).join("\n");

    const body = event.lines.map((l) => l.raw).join("\n");
    if (opts.verbose || opts.maxLength <= 0 || body.length <= opts.maxLength) {
        return header + "\n" + body;
    }
    return `${header}\n${body.slice(0, opts.maxLength)}\n... [truncated: ${body.length} chars — pass verbose=true for the full payload]`;
}
