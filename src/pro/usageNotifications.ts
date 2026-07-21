import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pushLogBox } from "../core/logbox.js";
import { CONFIG_DIR } from "../core/paths.js";
import { getPricingInfo, formatPlanPrice, type UsageInfo } from "../core/license.js";
import { API_BASE_URL } from "../core/config.js";

const NOTIFY_FILE = join(CONFIG_DIR, "usage-notify.json");
const UPGRADE_URL = `${API_BASE_URL}/upgrade`;

// Matches the fallback in ../pro/usageGate.ts — keep both in sync.
function proPrice(): string {
    const pricing = getPricingInfo();
    return pricing?.pro ? formatPlanPrice(pricing.pro) : "$8.99/mo";
}

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

        const askAgent = `Ask your AI assistant: "Check my ExecBro license status and help me link my account and upgrade to Pro."`;
        const msg =
            threshold === 100
                ? `ExecBro: free monthly limit reached (${usage.used}/${usage.limit}). Unlimited at ${UPGRADE_URL} — ${askAgent}`
                : `ExecBro: ${usage.used}/${usage.limit} free calls used this month. Unlimited at ${UPGRADE_URL} — ${askAgent}`;
        // Persist the dedup state BEFORE awaiting the push so the check-and-set window is
        // synchronous. This closes a TOCTOU race where two concurrent tool calls both read
        // stale state and both fire. Trade-off: if pushLogBox later fails, we do not retry
        // this threshold this month — "at most once" wins over "guaranteed delivery".
        state.lastThreshold = threshold;
        write(state);
        await pushLogBox(msg, "warning", false, "logbox", "ExecBro", device);
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
        const enforcementDate = new Date(usage.enforcementStartsAt);
        if (Number.isNaN(enforcementDate.getTime())) return; // malformed date — skip, don't mark notified
        const date = enforcementDate.toLocaleDateString("en-GB", { day: "2-digit", month: "long" });
        const msg =
            `ExecBro becomes metered on ${date}: 600 free tool calls per month, ` +
            `unlimited with Pro (${proPrice()}) at ${UPGRADE_URL}. As a thank-you to existing users, ` +
            `you already have a free month before the cap applies — nothing changes until ${date}. ` +
            `Ask your AI assistant: "Check my ExecBro license status and help me link my account before the free cap starts." ` +
            `Questions or feedback? Email zigor535@gmail.com.`;
        // Persist BEFORE awaiting the push (see maybeNotifyUsage) to close the same TOCTOU race.
        state.deferralNotifiedFor = usage.enforcementStartsAt;
        write(state);
        // warning level (grey) + expanded=true → dismissible full-screen LogBox view.
        await pushLogBox(msg, "warning", true, "logbox", "ExecBro", device);
    } catch {
        /* best-effort — never throw into the caller */
    }
}
