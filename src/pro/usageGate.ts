import type { UsageInfo } from "../core/license.js";
import { API_BASE_URL } from "../core/config.js";

const UPGRADE_URL = `${API_BASE_URL}/upgrade`;

// Tools that must never be gated so the stop can always explain itself, and
// account/feedback tools the user needs even while capped.
const EXEMPT = new Set<string>([
    "get_license_status",
    "activate_license",
    "send_feedback",
    "get_usage_guide",
    "dev",
    "reset_telemetry",
    "delete_account",
]);

let frozen = false;
let blockMessage: string | null = null;

function formatReset(usage: UsageInfo): string {
    if (!usage.resetsAt) return "next month";
    try {
        return new Date(usage.resetsAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    } catch {
        return "next month";
    }
}

function buildBlockMessage(usage: UsageInfo): string {
    return (
        `Action not performed — ExecBro free monthly limit reached ` +
        `(${usage.used}/${usage.limit}, resets ${formatReset(usage)}). ` +
        `Please tell the user: unlimited usage is available for $9/mo at ${UPGRADE_URL}.`
    );
}

// Freeze the block verdict once per process (session-start semantics). Called
// after ensureLicense() first resolves. Subsequent calls are no-ops so a user
// who crosses the cap mid-session is never interrupted.
export function freezeSessionVerdict(usage: UsageInfo | null): void {
    if (frozen) return;
    frozen = true;
    if (usage && usage.capActive !== false && !usage.canUse) {
        blockMessage = buildBlockMessage(usage);
    } else {
        blockMessage = null;
    }
}

export function isToolBlocked(toolName: string): { blocked: boolean; message?: string } {
    if (!frozen || !blockMessage) return { blocked: false };
    if (EXEMPT.has(toolName)) return { blocked: false };
    return { blocked: true, message: blockMessage };
}

// Live per-call warning (uses the locally-incremented usage.used) once ≥80%.
export function usageWarningLine(usage: UsageInfo | null): string | null {
    if (!usage || usage.capActive === false || usage.limit == null) return null;
    const threshold = (usage.warnThreshold ?? 0.8) * usage.limit;
    if (usage.used < threshold) return null;
    const remaining = Math.max(0, usage.limit - usage.used);
    return `ExecBro: ~${remaining} free calls left this month (resets ${formatReset(usage)}). Unlimited: ${UPGRADE_URL}`;
}

export function resetGateForTests(): void {
    frozen = false;
    blockMessage = null;
}
