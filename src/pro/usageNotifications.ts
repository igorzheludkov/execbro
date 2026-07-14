import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pushLogBox } from "../core/logbox.js";
import { CONFIG_DIR } from "../core/paths.js";
import type { UsageInfo } from "../core/license.js";
import { API_BASE_URL } from "../core/config.js";

const NOTIFY_FILE = join(CONFIG_DIR, "usage-notify.json");
const UPGRADE_URL = `${API_BASE_URL}/upgrade`;

interface NotifyState {
    monthKey?: string;
    lastThreshold?: 80 | 100;
    deferralNotifiedFor?: string; // enforcementStartsAt already warned about
}

function read(): NotifyState {
    try {
        return existsSync(NOTIFY_FILE) ? JSON.parse(readFileSync(NOTIFY_FILE, "utf-8")) : {};
    } catch {
        return {};
    }
}

function write(s: NotifyState): void {
    try {
        if (!existsSync(dirname(NOTIFY_FILE))) mkdirSync(dirname(NOTIFY_FILE), { recursive: true });
        writeFileSync(NOTIFY_FILE, JSON.stringify(s, null, 2));
    } catch {
        /* best-effort */
    }
}

export function nextThreshold(usage: UsageInfo | null): 80 | 100 | null {
    if (!usage || usage.capActive === false || usage.limit == null) return null;
    const pct = usage.used / usage.limit;
    if (pct >= 1) return 100;
    if (pct >= (usage.warnThreshold ?? 0.8)) return 80;
    return null;
}

// Fire the LogBox banner at most once per threshold per month.
export async function maybeNotifyUsage(usage: UsageInfo | null, device?: string): Promise<void> {
    try {
        const threshold = nextThreshold(usage);
        if (!usage || threshold == null) return;
        const state = read();
        if (state.monthKey !== usage.monthKey) {
            state.monthKey = usage.monthKey;
            state.lastThreshold = undefined;
        }
        if (state.lastThreshold === threshold || (state.lastThreshold === 100 && threshold === 80)) return;

        const msg =
            threshold === 100
                ? `ExecBro: free monthly limit reached (${usage.used}/${usage.limit}). Unlimited at ${UPGRADE_URL}`
                : `ExecBro: ${usage.used}/${usage.limit} free calls used this month. Unlimited at ${UPGRADE_URL}`;
        await pushLogBox(msg, "warning", false, "logbox", "ExecBro", device);
        state.lastThreshold = threshold;
        write(state);
    } catch {
        /* best-effort — never throw into the caller */
    }
}

// Existing-user deferral: grey full-screen dismissible warning, once per window.
export async function maybeNotifyDeferral(usage: UsageInfo | null, device?: string): Promise<void> {
    try {
        if (!usage || usage.capActive !== false || !usage.enforcementStartsAt) return;
        const state = read();
        if (state.deferralNotifiedFor === usage.enforcementStartsAt) return;
        const date = new Date(usage.enforcementStartsAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long" });
        const msg =
            `ExecBro becomes metered on ${date}: 600 free tool calls per month, ` +
            `unlimited with Pro ($9/mo) at ${UPGRADE_URL}. Nothing changes until then.`;
        // warning level (grey) + expanded=true → dismissible full-screen LogBox view.
        await pushLogBox(msg, "warning", true, "logbox", "ExecBro", device);
        state.deferralNotifiedFor = usage.enforcementStartsAt;
        write(state);
    } catch {
        /* best-effort — never throw into the caller */
    }
}
