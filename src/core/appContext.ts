import { buildRequireSource } from "./moduleRegistry.js";
import { FIBER_ROOTS_JS } from "./injected/fiberRoots.js";

/**
 * RESOLUTION ORDER — read this before adding a new handle to the context.
 *
 * When you need something the app holds privately, try the sources that are
 * *records the runtime already keeps* before reaching into live internals.
 * Records are stable and enumerable; internals are closures we usually cannot
 * open, and the introspection that does work tends to be the first thing to
 * break on a library upgrade.
 *
 *   1. Metro module registry (`__r.getModules()`) — anything a module exported.
 *      Resolved expo-router's imperative API when no global existed.
 *   2. SDK network buffer (`__RN_AI_DEVTOOLS__.getNetworkEntries()`) — anything
 *      that went over the wire: headers, endpoints, credentials.
 *      Resolved the bearer token for Apollo apps that keep none in redux.
 *   3. Fiber tree — anything passed as props or context. Resolves the redux
 *      store and React Navigation refs.
 *   4. Known globals and the SDK registry — cheap, but app-specific and often
 *      absent or, worse, a bespoke wrapper (Boardwise's `__EXPO_ROUTER__` is
 *      not the library's `router`).
 *   5. Introspection of live internals — last resort. Apollo's auth link is a
 *      closure over an async getter; Zustand stores are module-scoped hooks and
 *      never appear in the fiber tree at all.
 *
 * Two facts that motivate the ordering: single-strategy fiber resolution
 * accounted for 33 of 103 redux-tool failures (32%), and the two hardest
 * handles here — expo-router and the Apollo token — were both solved by
 * records (1 and 2), not by introspection.
 *
 * Rationale and evidence: docs/devtools-core/specs/2026-07-31-bounded-state-reads-design.md §4.
 */

export const CONTEXT_BINDINGS = [
    "require",
    "store",
    "state",
    "apollo",
    "cache",
    "deref",
    "router",
    "summary",
    "__eb_require"
] as const;

/**
 * Injected preamble exposing resolved app handles to every evaluated
 * expression.
 *
 * Motivated by telemetry, not ergonomics: store resolution is the single
 * largest failure cause for the redux tools (33 of 103 failures), because no
 * one strategy works across apps — `__REDUX_STORE__` exists in Boardwise and
 * astro but not gifted, while gifted has the SDK registry. Agents work around
 * it by hand-writing `__REDUX_STORE__ || __RN_AI_DEVTOOLS__.stores.redux`
 * fallback chains, and one recorded call was spent entirely on
 * `Object.keys(globalThis).filter(k => k.includes('REDUX'))`.
 *
 * Cost discipline: this runs on every call. The fiber walk is ~1 ms and is
 * done eagerly; `cache()` and `__eb_require` are deferred because
 * `cache.extract()` costs 17 ms and can materialise 1.6 MB, and indexing
 * ~4,000 modules is not free either.
 *
 * Every binding degrades to null rather than throwing. ES5 only — Hermes
 * compiles this string.
 */
export function buildContextPreamble(): string {
    return `
${buildRequireSource()}
// Expose under the natural name too, only where the runtime has none. Hermes
// has no require in the evaluate scope. A browser page may (Electron with
// nodeIntegration, AMD loaders), and a top-level var there IS a property of
// window, so an unguarded assignment replaced the app's own require.
// The __eb tag keeps our own from a previous call replaceable: each call's
// __eb_require re-indexes Metro modules, so a pinned one would go stale.
__eb_require.__eb = true;
var require = typeof require !== 'undefined' && !require.__eb ? require : __eb_require;
${FIBER_ROOTS_JS}
var __eb_fiberFind = function (predicate) {
    try {
        var found = null;
        var walk = function (f, d) {
            if (!f || d > 1600 || found) return;
            var p = f.memoizedProps;
            if (p) {
                var hit = predicate(p, f);
                if (hit) { found = hit; return; }
            }
            if (f.child) walk(f.child, d + 1);
            if (f.sibling) walk(f.sibling, d);
        };
        __eb_fiberRoots(true).forEach(function (r) { walk(r.current, 0); });
        return found;
    } catch (e) { return null; }
};
var __eb_isStore = function (v) {
    return !!v && typeof v === 'object' && typeof v.dispatch === 'function' &&
        typeof v.getState === 'function' && typeof v.subscribe === 'function';
};
var store = (function () {
    try {
        var viaFiber = __eb_fiberFind(function (p) { return __eb_isStore(p.store) ? p.store : null; });
        if (viaFiber) return viaFiber;
        if (__eb_isStore(globalThis.__REDUX_STORE__)) return globalThis.__REDUX_STORE__;
        var sdk = globalThis.__RN_AI_DEVTOOLS__;
        if (sdk && sdk.stores && __eb_isStore(sdk.stores.redux)) return sdk.stores.redux;
        if (sdk && sdk.custom && sdk.custom.StoreRegister && __eb_isStore(sdk.custom.StoreRegister.store)) {
            return sdk.custom.StoreRegister.store;
        }
        return null;
    } catch (e) { return null; }
})();
var state = store ? store.getState() : null;
var apollo = (function () {
    try {
        if (globalThis.__APOLLO_CLIENT__) return globalThis.__APOLLO_CLIENT__;
        return __eb_fiberFind(function (p) {
            return p.client && p.client.cache && typeof p.client.query === 'function' ? p.client : null;
        });
    } catch (e) { return null; }
})();
var __eb_cache = null;
function cache() {
    if (__eb_cache) return __eb_cache;
    if (!apollo || !apollo.cache || typeof apollo.cache.extract !== 'function') return null;
    try { __eb_cache = apollo.cache.extract(); } catch (e) { return null; }
    return __eb_cache;
}
var deref = function (value, c) {
    var source = c || __eb_cache;
    if (!value || typeof value !== 'object' || !value.__ref) return value;
    if (!source) return value;
    return source[value.__ref];
};
var router = (function () {
    try {
        var m = __eb_require('expo-router/build/imperative-api');
        if (m && m.router && typeof m.router.navigate === 'function') return m.router;
    } catch (e) { /* fall through */ }
    try {
        var viaFiber = __eb_fiberFind(function (p) {
            if (p.value && typeof p.value.navigate === 'function' && typeof p.value.resetRoot === 'function') return p.value;
            if (p.navigation && typeof p.navigation.navigate === 'function' && typeof p.navigation.resetRoot === 'function') return p.navigation;
            return null;
        });
        if (viaFiber) return viaFiber;
        var sdk = globalThis.__RN_AI_DEVTOOLS__;
        if (sdk && sdk.navigation) return sdk.navigation;
        if (globalThis.__EXPO_ROUTER__) return globalThis.__EXPO_ROUTER__;
        return null;
    } catch (e) { return null; }
})();
var summary = function (value) {
    if (!value || typeof value !== 'object') return value;
    var keys = Object.keys(value);
    var rows = [];
    for (var i = 0; i < keys.length; i++) {
        var v = value[keys[i]];
        var bytes = -1;
        try { bytes = JSON.stringify(v).length; } catch (e) { bytes = -1; }
        rows.push({
            key: keys[i],
            type: Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v),
            count: v && typeof v === 'object' ? Object.keys(v).length : undefined,
            bytes: bytes
        });
    }
    rows.sort(function (a, b) { return b.bytes - a.bytes; });
    return rows;
};
`.trim();
}
