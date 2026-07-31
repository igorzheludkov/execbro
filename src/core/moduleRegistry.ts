/**
 * Injected source for a working `require` inside Runtime.evaluate.
 *
 * Hermes has no `require` in the evaluate context, which is the second-largest
 * production failure class (236 events: 218 "require() is not available" plus
 * 18 "Property 'require' doesn't exist"). Agents reach for it to get `gql`,
 * `AsyncStorage`, `NativeModules`, app modules and library internals — none of
 * which are reachable any other way.
 *
 * Metro's dev registry does expose every loaded module keyed by numeric id,
 * with a `verboseName` path when the bundle is unminified. Verified live:
 * 4,398 named modules on AppC and 4,116 on AppB, where
 * `node_modules/expo-router/build/imperative-api.js` resolved to id 1017 and
 * `__r(1017)` returned working exports.
 *
 * ES5 only — this string is compiled by Hermes, not by tsc.
 */
export function buildRequireSource(): string {
    return `
var __eb_require = (function () {
    var cache = null;
    function index() {
        if (cache) return cache;
        var r = globalThis.__r;
        if (!r || typeof r.getModules !== 'function') return null;
        var entries = [];
        try {
            r.getModules().forEach(function (mod, id) {
                if (mod && mod.verboseName) entries.push({ id: id, name: mod.verboseName });
            });
        } catch (e) {
            return null;
        }
        cache = entries;
        return cache;
    }
    return function (name) {
        var entries = index();
        if (!entries) {
            return { __eb_error: 'Metro module registry is unavailable (globalThis.__r missing or has no getModules). Only pre-existing globals are reachable.' };
        }
        if (entries.length === 0) {
            return { __eb_error: 'Metro module registry exposed no module names (verboseName absent, likely a minified bundle). Only pre-existing globals are reachable.' };
        }
        var needle = String(name);
        var exact = [];
        var partial = [];
        for (var i = 0; i < entries.length; i++) {
            var n = entries[i].name;
            if (n === needle) exact.push(entries[i]);
            else if (n.indexOf(needle) !== -1) partial.push(entries[i]);
        }
        var hits = exact.length ? exact : partial;
        if (hits.length === 0) {
            return { __eb_error: 'require: no module matching "' + needle + '". Try a longer path fragment; ' + entries.length + ' modules are loaded.' };
        }
        hits.sort(function (a, b) { return a.name.length - b.name.length; });
        try {
            return globalThis.__r(hits[0].id);
        } catch (e) {
            return { __eb_error: 'require: module "' + hits[0].name + '" failed to evaluate: ' + String(e && e.message ? e.message : e) };
        }
    };
})();
`.trim();
}
