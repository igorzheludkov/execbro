import { buildRequireSource } from "./moduleRegistry.js";
import { FIBER_ROOTS_JS } from "./injected/fiberRoots.js";

/**
 * Injected source resolving BOTH navigation handles.
 *
 * Neither library provides both capabilities (measured 2026-07-31 across three
 * apps):
 *   - Expo Router's `router` navigates by path but has no getRootState, so it
 *     cannot say where the app currently is.
 *   - A React Navigation root ref reads state but has no push/replace (those
 *     are stack-scoped), and silently no-ops on Expo Router's path
 *     destinations — throwing nothing and warning only to LogBox.
 *
 * So `navigator` performs movement and `stateReader` reports position. On an
 * Expo Router app they are different objects.
 *
 * Resolution follows the order in appContext.ts: the Metro module registry
 * outranks app-exposed globals, because Boardwise's `__EXPO_ROUTER__` turned
 * out to be a hand-built wrapper rather than the library's router.
 *
 * The __EB_TEST_* hooks let the resolver be exercised without a fiber tree.
 * They are read only when present and cost nothing in production.
 *
 * ES5 only — Hermes compiles this string.
 */
export function buildNavHandlesSource(): string {
    return `
${buildRequireSource()}
${FIBER_ROOTS_JS}
var __eb_nav = (function () {
    function isExpoRouter(v) {
        return !!v && typeof v.navigate === 'function' && typeof v.dismiss === 'function';
    }
    function isRnRoot(v) {
        return !!v && typeof v.navigate === 'function' && typeof v.resetRoot === 'function';
    }
    function findFiberNav() {
        if (globalThis.__EB_TEST_FIBER_NAV__) return globalThis.__EB_TEST_FIBER_NAV__;
        try {
            var best = null;
            var bestDepth = 1e9;
            var walk = function (f, d) {
                if (!f || d > 1600) return;
                var p = f.memoizedProps;
                if (p) {
                    var c = isRnRoot(p.value) ? p.value : (isRnRoot(p.navigation) ? p.navigation : null);
                    if (c && d < bestDepth) { best = c; bestDepth = d; }
                }
                if (f.child) walk(f.child, d + 1);
                if (f.sibling) walk(f.sibling, d);
            };
            __eb_fiberRoots(true).forEach(function (r) { walk(r.current, 0); });
            return best;
        } catch (e) { return null; }
    }
    function findModuleRouter() {
        if (globalThis.__EB_TEST_MODULE_ROUTER__) return globalThis.__EB_TEST_MODULE_ROUTER__;
        try {
            var m = __eb_require('expo-router/build/imperative-api');
            if (m && isExpoRouter(m.router)) return m.router;
        } catch (e) { /* fall through */ }
        return null;
    }

    // Last resort: a SCREEN's navigation object, climbed to its root.
    //
    // isRnRoot above wants resetRoot, which only the NavigationContainer ref
    // has. An app that never creates that ref — plain <NavigationContainer>
    // with no ref prop, which is the default every React Navigation tutorial
    // shows — puts nothing matching it in the tree, and navigate answered "No
    // router resolved" on a perfectly ordinary router: 20 failures across 6
    // installations, both platforms, in the week to 2026-09-19.
    //
    // Every mounted screen is handed a navigation object through
    // NavigationContext, and getParent() walks it up to the root navigator,
    // whose navigate is the same dispatch the container ref would have used.
    // It has no getRootState, so it serves as navigator only and the route
    // table stays empty — destination validation is skipped rather than wrong.
    function findFiberScreenNav() {
        function isScreenNav(v) {
            return !!v && typeof v.navigate === 'function' && typeof v.dispatch === 'function' &&
                typeof v.getParent === 'function';
        }
        function toRoot(v) {
            var cur = v;
            for (var i = 0; i < 20; i++) {
                var up = null;
                try { up = cur.getParent(); } catch (e) { up = null; }
                if (!up || up === cur) break;
                cur = up;
            }
            return cur;
        }
        if (globalThis.__EB_TEST_SCREEN_NAV__) return toRoot(globalThis.__EB_TEST_SCREEN_NAV__);
        try {
            var found = null;
            var walk = function (f, d) {
                if (!f || found || d > 1600) return;
                var p = f.memoizedProps;
                if (p) {
                    var c = isScreenNav(p.value) ? p.value : (isScreenNav(p.navigation) ? p.navigation : null);
                    if (c) { found = c; return; }
                }
                if (f.child) walk(f.child, d + 1);
                if (f.sibling) walk(f.sibling, d);
            };
            __eb_fiberRoots(true).forEach(function (r) { walk(r.current, 0); });
            return found ? toRoot(found) : null;
        } catch (e) { return null; }
    }

    var moduleRouter = findModuleRouter();
    var fiberNav = findFiberNav();

    if (moduleRouter) {
        return {
            navigator: moduleRouter,
            stateReader: fiberNav || null,
            kind: 'expo-router',
            note: fiberNav ? null : 'Expo Router resolved, but no React Navigation root ref was found, so route state and destination validation are unavailable.'
        };
    }
    if (fiberNav) {
        return { navigator: fiberNav, stateReader: fiberNav, kind: 'react-navigation', note: null };
    }
    var screenNav = findFiberScreenNav();
    if (screenNav) {
        return {
            navigator: screenNav,
            stateReader: null,
            kind: 'react-navigation',
            note: 'Resolved through the navigation object of a mounted screen, not a NavigationContainer ref, so route state and destination validation are unavailable. Pass a ref to <NavigationContainer> to get them.'
        };
    }
    return {
        navigator: null,
        stateReader: null,
        kind: null,
        note: 'No router resolved. Tried the Metro module registry (expo-router), a fiber walk for a React Navigation root ref, and the navigation object of a mounted screen.'
    };
})();
`.trim();
}

/**
 * Injected source extracting the app's route table.
 *
 * React Navigation state carries `routeNames` per navigator — every registered
 * route at that level, not merely the mounted ones — so the whole table is
 * reachable without app cooperation. Boardwise's debug/navigation-debugger.tsx
 * hand-computes this today; this replaces it.
 *
 * Measured tables: gifted 41 routes across 3 levels, Boardwise 25 across 3,
 * astro 5 across 2.
 *
 * Requires __eb_nav. ES5 only.
 */
export function buildRouteTableSource(): string {
    return `
function __eb_routeTable() {
    var out = { levels: [], all: [], current: null };
    var reader = __eb_nav && __eb_nav.stateReader;
    if (!reader || typeof reader.getRootState !== 'function') return out;
    var root;
    try { root = reader.getRootState(); } catch (e) { return out; }
    var seen = {};
    function collect(st, d) {
        if (!st || d > 6) return;
        if (st.routeNames && st.routeNames.length) {
            out.levels.push({ depth: d, type: st.type || 'unknown', routeNames: st.routeNames });
            for (var i = 0; i < st.routeNames.length; i++) {
                var n = st.routeNames[i];
                if (!Object.prototype.hasOwnProperty.call(seen, n)) { seen[n] = 1; out.all.push(n); }
            }
        }
        if (st.routes) {
            for (var j = 0; j < st.routes.length; j++) {
                if (st.routes[j] && st.routes[j].state) collect(st.routes[j].state, d + 1);
            }
        }
    }
    collect(root, 0);
    try {
        var cur = typeof reader.getCurrentRoute === 'function' ? reader.getCurrentRoute() : null;
        out.current = cur ? cur.name : null;
    } catch (e) { out.current = null; }
    return out;
}
`.trim();
}

/**
 * Injected scorer for route-name suggestions.
 *
 * gifted registers 41 routes with names like CheckoutVerification and
 * AssociatedAccountVerification, so listing them all in an error is noise
 * exactly where the reader is already confused. Rank by closeness, show a few.
 *
 * Levenshtein is affordable here — route tables are tens of entries, not
 * thousands — and it catches the dropped-letter and transposition typos that
 * substring matching misses ("CheckoutVerfication").
 *
 * ES5 only.
 */
export function buildNearestRoutesSource(): string {
    return `
function __eb_editDistance(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
        cur[0] = i;
        for (j = 1; j <= n; j++) {
            var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
}
function __eb_nearestRoutes(needle, names, limit) {
    var lowerNeedle = String(needle).toLowerCase();
    var scored = [];
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var lower = name.toLowerCase();
        var score;
        if (lower === lowerNeedle) score = -3;
        else if (lower.indexOf(lowerNeedle) === 0) score = -2;
        else if (lower.indexOf(lowerNeedle) !== -1) score = -1;
        else score = __eb_editDistance(lowerNeedle, lower);
        scored.push({ name: name, score: score });
    }
    scored.sort(function (x, y) { return x.score - y.score; });
    var out = [];
    var cutoff = Math.max(3, Math.ceil(lowerNeedle.length / 2));
    for (var k = 0; k < scored.length && out.length < limit; k++) {
        if (scored[k].score <= cutoff) out.push(scored[k].name);
    }
    return out;
}
`.trim();
}

export type NavAction = "navigate" | "push" | "replace" | "back" | "reset";

/**
 * Injected source that validates, then performs, one navigation.
 *
 * Validation matters because the failure mode is silent: a path sent to a
 * React Navigation ref throws nothing, changes nothing, and reports only to
 * LogBox. Validating against the real route table converts that into an error
 * before dispatch. Expo Router destinations are paths, which never appear in
 * routeNames, so validation applies to React Navigation only.
 *
 * ES5 only.
 */
export function buildNavigateSource(
    action: string,
    to: string | null,
    params: Record<string, unknown> | null
): string {
    const actionLit = JSON.stringify(action);
    const toLit = JSON.stringify(to);
    const paramsLit = JSON.stringify(params);

    return `(function(){
    var action = ${actionLit};
    var to = ${toLit};
    var params = ${paramsLit};
    var nav = __eb_nav;
    if (!nav || !nav.navigator) {
        return { ok: false, kind: null, error: nav && nav.note ? nav.note : 'No router resolved.' };
    }
    var n = nav.navigator;
    var table = __eb_routeTable();
    var before = table.current;

    if (action !== 'back' && action !== 'reset' && !to) {
        // The route table is already in hand here. Returning it turns a dead
        // end into the answer the caller needed: 43 of these across 16 installs
        // in 30 days, and the agent had no way to learn the route names except
        // by asking this same tool.
        return { ok: false, badArgs: true, kind: nav.kind, error: 'A destination is required for action "' + action + '".', before: before, routes: table.all };
    }

    if (nav.kind === 'react-navigation' && to && table.all.length) {
        var known = false;
        for (var i = 0; i < table.all.length; i++) { if (table.all[i] === to) { known = true; break; } }
        if (!known) {
            var suggestions = __eb_nearestRoutes(to, table.all, 5);
            var extra = table.all.length - suggestions.length;
            var hint = suggestions.length
                ? 'Did you mean: ' + suggestions.join(', ') + (extra > 0 ? ' (' + extra + ' other routes registered)' : '')
                : table.all.length + ' routes are registered.';
            return {
                ok: false,
                kind: nav.kind,
                before: before,
                error: 'No route named "' + to + '" is registered. ' + hint +
                       ' (React Navigation takes route NAMES, not paths - a path here is silently ignored.)'
            };
        }
    }

    try {
        if (action === 'back') {
            if (typeof n.back === 'function') { n.back(); }
            else if (typeof n.goBack === 'function') { n.goBack(); }
            else { return { ok: false, kind: nav.kind, before: before, error: 'This router exposes neither back() nor goBack().' }; }
        } else if (action === 'reset') {
            if (typeof n.resetRoot === 'function') { n.resetRoot(); }
            else if (typeof n.dismissAll === 'function') { n.dismissAll(); }
            else { return { ok: false, kind: nav.kind, before: before, error: 'This router exposes neither resetRoot() nor dismissAll().' }; }
        } else {
            if (typeof n[action] !== 'function') {
                return {
                    ok: false, kind: nav.kind, before: before,
                    error: 'Action "' + action + '" is not available on this router (' + nav.kind +
                           '). A React Navigation root ref exposes navigate/goBack/reset only; push and replace are stack-scoped.'
                };
            }
            if (params) { n[action](to, params); } else { n[action](to); }
        }
    } catch (e) {
        return { ok: false, kind: nav.kind, before: before, error: String(e && e.message ? e.message : e) };
    }
    return { ok: true, kind: nav.kind, before: before };
})()`;
}
