/**
 * The credential vault: values the redactor recognises with high confidence,
 * stored server-side and rendered as a stable handle rather than a shape
 * description.
 *
 * Two capabilities, and the second is the stronger one:
 *
 *  - Identity. The same value always yields the same handle, so "the app is
 *    sending a different token than the one in its store" is one glance across
 *    a redux_get_state and a get_request_details, with nothing disclosed.
 *  - Exact matching. Once a literal value is here, every later tool result is
 *    filtered by exact string match rather than by shape or key name. A short
 *    opaque session id no heuristic would catch, seen once in a response
 *    header, is masked everywhere afterwards.
 *
 * Memory only. Never written to disk, never sent to telemetry. A restart
 * invalidates every handle and a handle from an old transcript resolves to
 * nothing, which is correct rather than a defect: it fails closed, and the
 * vault never becomes something worth stealing from disk. This is a session
 * cache, not a credential store.
 *
 * The vault is architecturally unreachable from execute_in_app: it lives in
 * this process, and execute_in_app runs in the app's JS runtime. That
 * isolation follows from where the vault lives rather than from a guard that
 * could be forgotten. It is also narrow: it means the vault adds no new easy
 * disclosure path, not that it withholds anything from an agent that would
 * read the token straight off Metro's unauthenticated inspector socket.
 */

import { createHash } from "node:crypto";

export interface VaultEntry {
    /** The only part of a secret that permanently enters the transcript. */
    handle: string;
    /** Verified shape, never claimed identity: "jwt", "stripe", "credential". */
    kind: string;
    /** Host the value was observed on, when there was one. */
    origin?: string;
    value: string;
    firstSeen: number;
    lastSeen: number;
    /** Derived from a JWT `exp` claim. No other claim is read or stored. */
    expiresAt?: number;
}

/**
 * Exact matching makes a false positive here far more damaging than one in the
 * renderer: a wrongly-vaulted common substring blanks unrelated output with no
 * visible cause. Hence the floor, and hence only high-confidence callers.
 */
const MIN_LENGTH = 20;
const MAX_ENTRIES = 200;

/** Insertion-ordered, so the first key is the oldest entry. */
const byHash = new Map<string, VaultEntry>();
/**
 * Every handle ever issued, including evicted ones. Handles are permanent
 * transcript content: reusing one would make two different credentials read as
 * the same credential in a transcript that outlives the process.
 */
const issued = new Set<string>();
/**
 * Origin host to the hash of the most recently observed value for it.
 *
 * Storage keys by content hash so every distinct token is its own entry, which
 * is what makes cross-sink identity work. Substitution needs the opposite: the
 * CURRENT credential for a position. A slot gives that, and it is why the vault
 * needs no destructive operations at all — the next capture after a re-login
 * supersedes the slot with no agent action, so "delete a stale entry" has
 * nothing to do. Adding that operation would only invite the agent to reason
 * about vault hygiene, which is not its job, and hand an injected instruction
 * a target.
 */
const slots = new Map<string, string>();

function hashOf(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** Accepts a bare host or a full URL; anything unparseable is used verbatim. */
function hostOf(origin: string): string {
    try {
        return new URL(origin).host || origin;
    } catch {
        return origin;
    }
}

/**
 * Read `exp` and nothing else.
 *
 * JWT payloads carry `sub`, email, org ids and roles. Those are PII that no
 * shape or key rule would ever match, so the vault must not become the thing
 * that puts them in front of the agent.
 */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+$/;

function jwtExpiry(value: string): number | undefined {
    // Keyed on SHAPE, not on the caller's `kind`. redactHeaderValue vaults a
    // bearer token as kind "auth" because that is what the header says, and
    // gating on the label meant the single most common credential in the
    // product — a JWT in an Authorization header — was the one entry that
    // never got an expiry, which is precisely the staleness the catalog is
    // supposed to surface before a 401 rather than after one.
    if (!JWT_SHAPE.test(value)) return undefined;
    const payload = value.split(".")[1];
    if (!payload) return undefined;
    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
        return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
    } catch {
        return undefined;
    }
}

function assignHandle(kind: string, origin?: string): string {
    const base = `${kind}_${origin ?? "app"}`;
    if (!issued.has(base)) {
        issued.add(base);
        return base;
    }
    for (let n = 2; ; n++) {
        const candidate = `${base}#${n}`;
        if (!issued.has(candidate)) {
            issued.add(candidate);
            return candidate;
        }
    }
}

/**
 * Record a value and return its handle, or undefined when it is too short to
 * be matched exactly without risk.
 *
 * `kind` is the verified shape the caller matched. `origin` may be a host or a
 * full URL; only its host is kept, because a path can carry a user id.
 */
export function vaultAdd(value: string, kind: string, origin?: string): string | undefined {
    if (value.length < MIN_LENGTH) return undefined;

    const key = hashOf(value);
    const existing = byHash.get(key);
    if (existing) {
        existing.lastSeen = Date.now();
        if (!existing.origin && origin) existing.origin = hostOf(origin);
        if (existing.origin) slots.set(existing.origin, key);
        return existing.handle;
    }

    const host = origin ? hostOf(origin) : undefined;
    const now = Date.now();
    byHash.set(key, {
        handle: assignHandle(kind, host),
        kind,
        origin: host,
        value,
        firstSeen: now,
        lastSeen: now,
        expiresAt: jwtExpiry(value)
    });

    if (host) slots.set(host, key);

    const handle = byHash.get(key)!.handle;
    if (byHash.size > MAX_ENTRIES) {
        const oldest = byHash.keys().next().value;
        if (oldest !== undefined) byHash.delete(oldest);
    }
    return handle;
}

/** Newest first. */
export function vaultEntries(): VaultEntry[] {
    return [...byHash.values()].reverse();
}

export function vaultByHandle(handle: string): VaultEntry | undefined {
    for (const entry of byHash.values()) {
        if (entry.handle === handle) return entry;
    }
    return undefined;
}

/**
 * Handles that are currently the slot holder for their origin, i.e. the ones a
 * bare origin name resolves to.
 *
 * Verified live on 2026-09-05: priming the vault from an Authorization header
 * and then running vault_capture for the same origin repointed the slot to the
 * captured value, which was a different KIND of credential (a redux `secret`
 * field, not the bearer token). The next http_request by origin got "Error
 * decode access token" from a real backend. Slots have no notion of kind and
 * should not grow one — newest-wins is what makes a re-login need no agent
 * action — but the displacement must not be invisible, which is what this is
 * for. Addressing the older value by its handle still works.
 */
export function vaultSlotHandles(): Set<string> {
    const current = new Set<string>();
    for (const hash of slots.values()) {
        const entry = byHash.get(hash);
        if (entry) current.add(entry.handle);
    }
    return current;
}

export function resetVaultForTests(): void {
    byHash.clear();
    issued.clear();
    slots.clear();
}

/**
 * Resolve a name the agent supplied to an entry.
 *
 * A handle names one specific value; a slot names whatever is current for an
 * origin. Both are accepted because the spec's examples pass an origin while
 * every rendered result the agent has actually seen names a handle, and an
 * origin-only parameter would invite a wrong guess on the first call. This is
 * safe to be generous about: origin binding is enforced against the resolved
 * entry's own recorded origin, never against the name passed in, so a handle
 * is not a way around the check.
 */
export function vaultResolve(nameOrHandle: string): VaultEntry | undefined {
    const byName = vaultByHandle(nameOrHandle);
    if (byName) return byName;
    const hash = slots.get(hostOf(nameOrHandle));
    return hash ? byHash.get(hash) : undefined;
}

/**
 * Why an entry might not work, before it is used.
 *
 * Staleness should be visible in the catalog rather than discovered through a
 * 401. Returns undefined when there is nothing to warn about, so callers can
 * treat it as an optional line.
 */
export function vaultStaleness(entry: VaultEntry): string | undefined {
    if (entry.expiresAt === undefined) return undefined;
    const now = Date.now();
    if (entry.expiresAt <= now) {
        return `${entry.handle} expired ${ageLabel(now - entry.expiresAt)} (first seen ${ageLabel(now - entry.firstSeen)}). The vault cannot mint a token; only the app can. Drive a re-login, or capture the fresh token with vault_capture.`;
    }
    if (entry.expiresAt - now < 60_000) {
        return `${entry.handle} expires in under a minute.`;
    }
    return undefined;
}

/** One catalog row. Shared by the redaction footer and list_secrets. */
export function vaultCatalogLine(entry: VaultEntry, now: number): string {
    const where = entry.origin ? ` seen on ${entry.origin}` : " seen in the app";
    const parts = [`${entry.kind}${where}`, `first seen ${ageLabel(now - entry.firstSeen)}`];
    if (entry.expiresAt !== undefined) {
        parts.push(
            entry.expiresAt <= now ? "EXPIRED" : `expires in ${ageLabel(entry.expiresAt - now).replace(" ago", "")}`,
        );
    }
    return `${entry.handle}: ${parts.join(", ")}`;
}

/** The one place the on-the-wire rendering of a handle is defined. */
export function vaultHandleRef(handle: string): string {
    return `[secret:${handle}]`;
}

/**
 * Replace every vaulted literal in `text`, recording the handles emitted.
 *
 * This is the strongest thing the vault buys and it has nothing to do with
 * substitution: heuristic coverage becomes exact coverage for anything seen
 * once. It matters most where per-frame heuristics are least reliable and most
 * expensive, such as a WebSocket subscription re-sending its auth token in
 * hundreds of frames.
 *
 * Longest first, so a token that contains a shorter vaulted value does not get
 * half-masked into an unrecognisable fragment.
 *
 * ponytail: O(entries x text) with a plain indexOf guard. At a 200-entry cap
 * that is a few hundred substring scans per tool result, far below the JSON
 * projection already running on the same text. Build a trie or an Aho-Corasick
 * automaton only if a profile ever says this shows up.
 */
export function vaultMaskExact(text: string, hits: Set<string>): string {
    let out = text;
    const entries = [...byHash.values()].sort((a, b) => b.value.length - a.value.length);
    for (const entry of entries) {
        if (!out.includes(entry.value)) continue;
        out = out.split(entry.value).join(vaultHandleRef(entry.handle));
        entry.lastSeen = Date.now();
        hits.add(entry.handle);
    }
    return out;
}

function ageLabel(ms: number): string {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}

/**
 * Explain the handles that appeared, using derived facts only.
 *
 * Never the claims: a JWT payload carries `sub`, email, org ids and roles.
 * Never a path either, because "first seen in a request to /v1/users/12345"
 * puts a user id in the catalog just as surely as reading `sub` would.
 *
 * Staleness is meant to be visible here, before a call is made, rather than
 * discovered through a 401.
 */
export function vaultCatalog(handles: Set<string>): string {
    if (handles.size === 0) return "";
    const now = Date.now();
    const lines: string[] = ["--- secrets referenced above ---"];
    for (const handle of handles) {
        const entry = vaultByHandle(handle);
        if (!entry) continue;
        lines.push(vaultCatalogLine(entry, now));
    }
    return lines.join("\n");
}
