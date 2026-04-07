import { executeInApp } from "./executor.js";

// ── Types ──

export interface LogBoxEntry {
    level: string;
    message: string;
    count: number;
}

export interface LogBoxState {
    total: number;
    errors: number;
    warnings: number;
    fatals: number;
    entries: LogBoxEntry[];
}

export interface LogBoxDismissResult {
    dismissed: LogBoxEntry[];
    totalDismissed: number;
    errors: number;
    warnings: number;
    fatals: number;
}

// ── JS Expression Fragments ──
// Composed into full expressions for detect and dismiss operations.
// Each runs inside the RN app via Runtime.evaluate.

const FIND_LOGBOX_DATA = `
  var LogBoxData = global.__RN_LOGBOX_DATA__;
  if (!LogBoxData || !LogBoxData.observe) {
    if (!global.__DEV__) return JSON.stringify(null);
    var getModules = global.__r && global.__r.getModules;
    if (!getModules) return JSON.stringify(null);
    var modules = getModules();
    if (!modules || typeof modules.forEach !== 'function') return JSON.stringify(null);
    modules.forEach(function(mod) {
      if (LogBoxData) return;
      if (mod && mod.isInitialized && mod.publicModule && mod.publicModule.exports) {
        var e = mod.publicModule.exports;
        if (e.clearErrors && e.observe && e.addLog && e.clearWarnings) {
          LogBoxData = e;
        }
      }
    });
    if (!LogBoxData) return JSON.stringify(null);
    global.__RN_LOGBOX_DATA__ = LogBoxData;
  }
`;

const READ_LOGBOX_STATE = `
  var state = null;
  var sub = LogBoxData.observe(function(data) { state = data; });
  if (sub && sub.unsubscribe) sub.unsubscribe();
  if (!state || !state.logs) return JSON.stringify(null);
  var summary = { error: 0, warning: 0, fatal: 0 };
  var entries = [];
  state.logs.forEach(function(log) {
    if (summary[log.level] !== undefined) summary[log.level]++;
    var msg = log.message && log.message.content ? log.message.content : '';
    entries.push({ level: log.level, message: msg, count: log.count || 1 });
  });
`;

const DETECT_EXPRESSION = `(function() {
${FIND_LOGBOX_DATA}
${READ_LOGBOX_STATE}
  return JSON.stringify({
    total: entries.length,
    errors: summary.error,
    warnings: summary.warning,
    fatals: summary.fatal,
    entries: entries
  });
})()`;

const DISMISS_EXPRESSION = `(function() {
${FIND_LOGBOX_DATA}
${READ_LOGBOX_STATE}
  LogBoxData.clearErrors();
  LogBoxData.clearWarnings();
  return JSON.stringify({
    dismissed: entries,
    totalDismissed: entries.length,
    errors: summary.error,
    warnings: summary.warning,
    fatals: summary.fatal
  });
})()`;

// ── Public API ──

/**
 * Read current LogBox state without modifying it.
 * Returns null if LogBox is not available (production app, no CDP connection, etc.)
 */
export async function detectLogBox(device?: string): Promise<LogBoxState | null> {
    try {
        const result = await executeInApp(DETECT_EXPRESSION, true, { timeoutMs: 5000 }, device);
        if (!result.success || !result.result) return null;
        const parsed = JSON.parse(result.result);
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Clear all LogBox entries and return what was dismissed.
 * Returns null if LogBox is not available.
 */
export async function dismissLogBox(device?: string): Promise<LogBoxDismissResult | null> {
    try {
        const result = await executeInApp(DISMISS_EXPRESSION, true, { timeoutMs: 5000 }, device);
        if (!result.success || !result.result) return null;
        const parsed = JSON.parse(result.result);
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Build a warning string for appending to screenshot/OCR tool responses.
 * Returns empty string if no LogBox entries detected.
 */
export function formatLogBoxWarning(state: LogBoxState): string {
    if (state.total === 0) return "";

    const parts: string[] = [];
    if (state.errors > 0) parts.push(`${state.errors} error${state.errors > 1 ? "s" : ""}`);
    if (state.fatals > 0) parts.push(`${state.fatals} fatal${state.fatals > 1 ? "s" : ""}`);
    if (state.warnings > 0) parts.push(`${state.warnings} warning${state.warnings > 1 ? "s" : ""}`);

    return (
        `\n\nWarning: LogBox overlay detected (${parts.join(", ")}). Bottom UI may be obstructed.` +
        `\nUse dismiss_logbox to clear (dismissed content will be returned).`
    );
}

/**
 * Format dismissed LogBox entries for the dismiss_logbox tool response.
 * Full messages in raw data, truncated in display.
 */
export function formatDismissedEntries(result: LogBoxDismissResult): string {
    if (result.totalDismissed === 0) return "No LogBox entries to dismiss.";

    const MAX_MSG_LENGTH = 150;
    let output = `Dismissed ${result.totalDismissed} LogBox entr${result.totalDismissed === 1 ? "y" : "ies"}:\n`;

    for (const entry of result.dismissed) {
        const truncated = entry.message.length > MAX_MSG_LENGTH
            ? entry.message.substring(0, MAX_MSG_LENGTH) + "..."
            : entry.message;
        const countStr = entry.count > 1 ? ` (x${entry.count})` : "";
        output += `\n[${entry.level}] ${truncated}${countStr}`;
    }

    const parts: string[] = [];
    if (result.errors > 0) parts.push(`${result.errors} error${result.errors > 1 ? "s" : ""}`);
    if (result.fatals > 0) parts.push(`${result.fatals} fatal${result.fatals > 1 ? "s" : ""}`);
    if (result.warnings > 0) parts.push(`${result.warnings} warning${result.warnings > 1 ? "s" : ""}`);

    output += `\n\nSummary: ${parts.join(", ")}`;
    output += `\nBottom UI should now be unobstructed.`;

    return output;
}
