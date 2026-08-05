import { UserInputError } from "./errors.js";

/**
 * Server-side store for network mock rules.
 *
 * The server is authoritative and the app is a cache: rules are pushed on every
 * mutation and re-pushed whenever a new JS context appears (connection.ts), so
 * a mock survives reload_app. App-side-only rules would be dropped by every
 * reload — silently, and exactly when reproducing a startup-path bug.
 */

export interface MockRule {
    id: string;
    url: string;
    method?: string;
    mode: "replace" | "tamper";
    times?: number;
    delayMs?: number;
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    networkError?: string;
    set?: Record<string, unknown>;
    remove?: string[];
    bodyReplace?: string;
    /**
     * Which tool created the rule. `network_condition` owns exactly one rule per
     * device and replaces it on every call; without this tag it would have to
     * clear the whole device to find its own rule, destroying the agent's mocks
     * as a side effect of asking for "offline".
     */
    source?: "mock" | "condition";
    /** Match count, maintained server-side from interceptor reports. */
    hits: number;
}

export type MockRuleInput = Omit<MockRule, "id" | "hits">;

const rulesByDevice = new Map<string, MockRule[]>();
// Never reset by removal: a reused id would let a stale reference resolve to a
// different rule, which is worse than an id that simply no longer exists.
let nextId = 1;

/** Longest accepted regex source. Real endpoint patterns are far shorter. */
const MAX_PATTERN_LENGTH = 200;
/**
 * Adversarial probe length. Short enough that even an exponential pattern
 * finishes in milliseconds — the check must not become the hang it prevents —
 * but long enough that exponential and linear are orders of magnitude apart.
 */
const PROBE_INPUT_LENGTH = 22;
const PROBE_BUDGET_MS = 20;

/** Test-only. */
export function __resetMockRules(): void {
    rulesByDevice.clear();
    nextId = 1;
}

/** True when the pattern is slash-wrapped, i.e. the app will compile it as a regex. */
function isRegexPattern(pattern: string): boolean {
    return (
        pattern.length > 1 &&
        pattern.charAt(0) === "/" &&
        pattern.charAt(pattern.length - 1) === "/"
    );
}

/**
 * True when `body` can repeat unboundedly or branch — the ingredient that turns
 * an outer quantifier into exponential backtracking.
 */
function bodyCanRepeatOrBranch(body: string): boolean {
    let inClass = false;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === "\\") {
            i++;
            continue;
        }
        if (inClass) {
            if (c === "]") inClass = false;
            continue;
        }
        if (c === "[") {
            inClass = true;
            continue;
        }
        if (c === "*" || c === "+" || c === "|") return true;
        if (c === "{" && /^\{\d+,\}/.test(body.slice(i))) return true;
    }
    return false;
}

/**
 * Structural check for the classic catastrophic shapes — `(a+)+`, `(.*)*`,
 * `(a|aa)+` — a quantified group whose body itself repeats or branches.
 */
function hasRiskyNesting(pattern: string): boolean {
    const openStack: number[] = [];
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") {
            i++;
            continue;
        }
        if (inClass) {
            if (c === "]") inClass = false;
            continue;
        }
        if (c === "[") {
            inClass = true;
            continue;
        }
        if (c === "(") {
            openStack.push(i);
            continue;
        }
        if (c === ")") {
            const open = openStack.pop();
            if (open === undefined) continue;
            const rest = pattern.slice(i + 1);
            const quantified =
                rest.charAt(0) === "*" ||
                rest.charAt(0) === "+" ||
                /^\{\d+,\}/.test(rest);
            if (!quantified) continue;
            if (bodyCanRepeatOrBranch(pattern.slice(open + 1, i))) return true;
        }
    }
    return false;
}

/**
 * Validates a rule's `url` before it is stored.
 *
 * Slash-wrapped patterns are compiled and executed inside the app's single JS
 * thread, so a catastrophically-backtracking pattern does not slow a tool down —
 * it freezes the app under test, and the agent has no way to tell that from the
 * bug it was chasing. Rejecting server-side is the only place with a thread to
 * spare. Plain substrings are not patterns and are never checked.
 *
 * @throws UserInputError when the pattern cannot compile or looks dangerous.
 */
export function validateUrlPattern(pattern: string): void {
    if (!isRegexPattern(pattern)) return;
    const source = pattern.slice(1, -1);

    if (source.length > MAX_PATTERN_LENGTH) {
        throw new UserInputError(
            `Regex pattern is too long (${source.length} chars, max ${MAX_PATTERN_LENGTH}). ` +
                `It runs inside the app's JS thread on every request. Use a shorter pattern, ` +
                `or a plain substring (no surrounding slashes) for a literal match.`,
            "mock_pattern_too_long"
        );
    }

    let re: RegExp;
    try {
        re = new RegExp(source);
    } catch (err) {
        throw new UserInputError(
            `Regex pattern "${pattern}" does not compile: ${err instanceof Error ? err.message : String(err)}. ` +
                `Omit the surrounding slashes if you meant a literal substring.`,
            "mock_pattern_invalid"
        );
    }

    if (hasRiskyNesting(source)) {
        throw new UserInputError(
            `Regex pattern "${pattern}" has a nested quantifier (e.g. (a+)+, (.*)*, (a|aa)+) and can ` +
                `backtrack catastrophically. It would run in the app's JS thread and freeze it. ` +
                `Rewrite it without the nesting, or use a plain substring.`,
            "mock_pattern_backtracking"
        );
    }

    // Backstop for shapes the structural scan misses. The probe is deliberately
    // short so an exponential pattern costs milliseconds here rather than hanging.
    const probe = "a".repeat(PROBE_INPUT_LENGTH) + "!";
    const start = Date.now();
    try {
        re.test(probe);
    } catch {
        // A pattern that throws at match time is not a backtracking risk.
        return;
    }
    const elapsed = Date.now() - start;
    if (elapsed > PROBE_BUDGET_MS) {
        throw new UserInputError(
            `Regex pattern "${pattern}" is too slow (${elapsed}ms on a ${probe.length}-character probe) — ` +
                `it backtracks and would freeze the app's JS thread. Rewrite it or use a plain substring.`,
            "mock_pattern_slow"
        );
    }
}

export function addRule(device: string, input: MockRuleInput): MockRule {
    validateUrlPattern(input.url);
    const rule: MockRule = { ...input, id: `m${nextId++}`, hits: 0 };
    const list = rulesByDevice.get(device) ?? [];
    list.push(rule);
    rulesByDevice.set(device, list);
    return rule;
}

export function removeRule(device: string, id: string): boolean {
    const list = rulesByDevice.get(device);
    if (!list) return false;
    const i = list.findIndex((r) => r.id === id);
    if (i === -1) return false;
    list.splice(i, 1);
    return true;
}

export function clearRules(device?: string): number {
    if (device === undefined) {
        let n = 0;
        for (const list of rulesByDevice.values()) n += list.length;
        rulesByDevice.clear();
        return n;
    }
    const list = rulesByDevice.get(device);
    if (!list) return 0;
    const n = list.length;
    rulesByDevice.delete(device);
    return n;
}

/**
 * Removes only the rules `network_condition` owns, leaving agent-authored mocks
 * in place. Returns how many were removed.
 */
export function clearConditionRules(device: string): number {
    const list = rulesByDevice.get(device);
    if (!list) return 0;
    const kept = list.filter((r) => r.source !== "condition");
    const removed = list.length - kept.length;
    rulesByDevice.set(device, kept);
    return removed;
}

export function listRules(device: string): MockRule[] {
    return rulesByDevice.get(device) ?? [];
}

export function recordHit(device: string, id: string): void {
    const rule = rulesByDevice.get(device)?.find((r) => r.id === id);
    if (rule) rule.hits++;
}

/**
 * The rule array as the injected script sees it. `hits` and `source` are
 * stripped — the app does not need either, and sending `hits` would imply the
 * app is authoritative for a counter the server owns.
 */
export function serializeRules(device: string): string {
    const wire = listRules(device).map(({ hits: _hits, source: _source, ...rest }) => rest);
    return JSON.stringify(wire);
}

/**
 * One-line banner appended to every network read while rules exist, so an agent
 * cannot forget it is looking at altered traffic.
 */
export function activeMockBanner(device: string): string {
    const n = listRules(device).length;
    if (n === 0) return "";
    return `\n\n[${n} mock rule(s) active on ${device} — network_mock({action:"list"}) to inspect, {action:"clear"} to remove]`;
}
