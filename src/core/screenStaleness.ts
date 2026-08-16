/**
 * Did the screen move under the agent, or did the agent aim at the wrong thing?
 *
 * `tap` and `input_text` both fail with a targeting miss — "no element found",
 * "no TextInput matched that target" — and those two words cover three
 * completely different situations that the error message cannot tell apart:
 *
 *   1. The agent named something that was never on this screen. Its plan was
 *      wrong, or its model of the screen was stale by its own doing.
 *   2. The screen changed underneath it. A person is driving the simulator in
 *      parallel — they scrolled, dismissed the keyboard, unfocused the field,
 *      or navigated away between the agent forming its plan and the call
 *      landing. Nothing about the tool is broken.
 *   3. Everything was there and the matcher still said no. This is the only
 *      one that is a bug in us.
 *
 * All three land in `validation` today, which is why a 25.8% input_text failure
 * rate on 2.8.1 says nothing about whether input_text works. Separating them is
 * the same argument that gave `driver_missing` its own bucket for tap: a
 * failure the tool could not have prevented must not be counted against it,
 * but must still be visible when it spikes.
 *
 * The discriminator is a comparison, not a measurement. We remember what the
 * agent was last shown on a device and compare it with what is there now.
 */

/** What the caller is told happened. See the module comment for why each exists. */
export type StaleKind = "genuine_miss" | "stale_navigation" | "stale_inscreen";

export interface ScreenSnapshot {
    /**
     * Stable identity of every targetable element on screen, order-independent.
     * Built by the caller — only it knows what "targetable" means for its tool.
     */
    elements: string[];
    /** Whether anything held input focus at this moment. */
    focused: boolean;
}

export interface StalenessVerdict {
    kind: StaleKind;
    /** Age of the snapshot this was compared against. Absent without a baseline. */
    agoMs?: number;
    /**
     * One sentence for the agent, naming what changed and what to do about it.
     * Empty for `genuine_miss` — there is nothing to say beyond the candidate
     * list the tool already returned.
     */
    note: string;
    /** Compact telemetry tag, e.g. `screen_changed:navigation`. Empty for a genuine miss. */
    tag: string;
}

/**
 * Tools that are SUPPOSED to change the screen. When one of these ran since the
 * baseline was taken, a changed screen is the agent's own doing and not a race
 * — counting it as one would report every ordinary multi-step flow as
 * interference.
 */
const MUTATING_TOOLS = new Set([
    "tap",
    "swipe",
    "pinch",
    "input_text",
    "navigate",
    "reload_app",
    "logbox",
    "dismiss_keyboard",
    "redux_dispatch",
    "execute_in_app",
    "android_key_event",
    "android_launch_app",
    "android_long_press",
    "ios_button",
    "ios_launch_app",
    "ios_open_url",
    "ios_terminate_app"
]);

const snapshots = new Map<string, { snap: ScreenSnapshot; at: number }>();

/**
 * When a tool that changes the screen last ran — NOT which tool ran last.
 *
 * The distinction is the whole correctness of the attribution. Remembering only
 * the most recent tool loses the fact that the agent moved the screen as soon
 * as it reads anything afterwards, and `tap -> get_screen_state -> input_text`
 * is the common loop: the read would erase the tap, and the miss would be
 * blamed on a passer-by. It only ever moves forward, so a read cannot un-know
 * a mutation.
 */
let lastMutatingAt = 0;

/**
 * Records that a tool ran, so a changed screen can be attributed to it.
 *
 * Called from the telemetry wrapper's `finally`, which means that while a
 * handler is executing this still describes everything BEFORE it — exactly
 * what the comparison needs.
 */
export function recordToolCall(name: string, at: number = Date.now()): void {
    if (MUTATING_TOOLS.has(name) && at > lastMutatingAt) lastMutatingAt = at;
}

/** Test seam. The maps are process-lifetime by design. */
export function resetScreenStalenessForTests(): void {
    snapshots.clear();
    lastMutatingAt = 0;
}

function keyFor(device?: string): string {
    return device ?? "__default__";
}

/** Records what is on screen now, becoming the baseline for the next comparison. */
export function recordScreen(device: string | undefined, snap: ScreenSnapshot, at: number = Date.now()): void {
    snapshots.set(keyFor(device), { snap, at });
}

function formatAgo(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compares what is on screen now against what the agent was last shown, and
 * replaces the baseline with `current`.
 *
 * Always call this on a targeting miss, never on the happy path — it is a
 * diagnosis of a failure that already happened, and recording the baseline is
 * `recordScreen`'s job.
 */
export function diagnoseStaleness(
    device: string | undefined,
    current: ScreenSnapshot,
    at: number = Date.now()
): StalenessVerdict {
    const key = keyFor(device);
    const prev = snapshots.get(key);
    snapshots.set(key, { snap: current, at });

    const miss: StalenessVerdict = { kind: "genuine_miss", note: "", tag: "" };

    // Nothing to compare against. Saying "the screen changed" here would be a
    // guess, and a guess that excuses a real miss is worse than no signal.
    if (!prev) return miss;

    const agoMs = Math.max(0, at - prev.at);

    // The agent moved the screen itself since the baseline was taken. Expected,
    // not interference — and the reason the baseline wants to come from the
    // agent's most recent LOOK at the screen (get_screen_state) rather than
    // from a resolve, which necessarily predates the action it resolved for.
    if (lastMutatingAt >= prev.at) return miss;

    const before = new Set(prev.snap.elements);
    const after = new Set(current.elements);
    let overlap = 0;
    for (const el of after) {
        if (before.has(el)) overlap++;
    }

    const lostFocus = prev.snap.focused && !current.focused;
    const sameElements = before.size === after.size && overlap === before.size;

    if (sameElements && !lostFocus) return miss;

    // ponytail: nothing on screen is shared, so this is almost certainly a
    // route change — but it is inferred from the element sets, not read from
    // routeHistory. It misreads a full in-place list swap as navigation.
    // Upgrade path: read the current route (routeHistory.ts already records
    // `enteredAt` per visit) and compare it, which answers this exactly.
    if (before.size > 0 && after.size > 0 && overlap === 0) {
        return {
            kind: "stale_navigation",
            agoMs,
            tag: "screen_changed:navigation",
            note:
                `The screen changed completely in the ${formatAgo(agoMs)} since your last look at it, and no` +
                ` tool of yours moved it — someone is using the app in parallel. Re-read the screen before` +
                ` retargeting; the element you named may well exist on the screen you were expecting.`
        };
    }

    const what = lostFocus && sameElements
        ? "the focused field lost focus"
        : `the set of elements on screen changed (${before.size} → ${after.size}, ${overlap} in common)`;

    return {
        kind: "stale_inscreen",
        agoMs,
        tag: "screen_changed:inscreen",
        note:
            `Still the same screen, but ${what} in the ${formatAgo(agoMs)} since your last look at it, and no` +
            ` tool of yours caused it — someone is scrolling or typing in the app in parallel. Re-read the` +
            ` screen before retargeting.`
    };
}

/** Identity of one input for snapshot purposes. Stable across scroll and re-render. */
export function inputIdentity(c: {
    testID?: string | null;
    component?: string | null;
    placeholder?: string | null;
    label?: string | null;
}): string {
    // Deliberately excludes `value`: the agent typing into a field changes its
    // value, and a field whose identity changed when written to would report
    // every successful write as the screen having moved.
    return c.testID || [c.component, c.placeholder, c.label].filter(Boolean).join("|") || "?";
}
