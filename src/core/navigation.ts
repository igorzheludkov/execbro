import { buildRequireSource } from "./moduleRegistry.js";

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
 * outranks app-exposed globals, because AppB's `__EXPO_ROUTER__` turned
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
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook || typeof hook.getFiberRoots !== 'function' || !hook.renderers) return null;
            var best = null;
            var bestDepth = 1e9;
            var ids = [];
            hook.renderers.forEach(function (_, k) { ids.push(k); });
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
            for (var i = 0; i < ids.length; i++) {
                var roots = hook.getFiberRoots(ids[i]);
                if (!roots) continue;
                roots.forEach(function (r) { walk(r.current, 0); });
            }
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
    return {
        navigator: null,
        stateReader: null,
        kind: null,
        note: 'No router resolved. Tried the Metro module registry (expo-router) and a fiber walk for a React Navigation root ref.'
    };
})();
`.trim();
}
