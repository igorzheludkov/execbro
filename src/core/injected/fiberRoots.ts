/**
 * The one fiber-root lookup for injected JS. There used to be 17 hand copies,
 * and they had already drifted (navigation.ts bailed when getFiberRoots was
 * missing, screenState.ts did not), so there was nowhere to add a fallback.
 *
 * Resolution order:
 *  1. The DevTools hook, byte-for-byte what the copies did: renderer 1, then
 *     the renderers map. `all` unions every renderer instead of stopping at the
 *     first non-empty one, for the sites that walked them all.
 *  2. The DOM. Vite's injectIntoGlobalHook installs a stub hook with no
 *     renderers, so a React app in Electron or Chrome reports an empty tree
 *     rather than an error. React stores the HostRoot fiber on its container as
 *     `__reactContainer$<key>`. Its `stateNode` is the real FiberRoot, and that
 *     is what we return: the stored fiber is written once at createRoot and can
 *     be the stale alternate after a commit, while `stateNode.current` is always
 *     live. A `{ current: fiber }` shim covers the case with no stateNode, so
 *     every caller keeps reading `roots[i].current`.
 *
 * The `document` guard makes step 2 unreachable in Hermes.
 */
export const FIBER_ROOTS_JS = `
function __eb_fiberRoots(all) {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var roots = [];
    var add = function (list) {
        for (var i = 0; i < list.length; i++) if (roots.indexOf(list[i]) < 0) roots.push(list[i]);
    };
    if (hook && typeof hook.getFiberRoots === 'function') {
        if (!all) {
            try { add(Array.from(hook.getFiberRoots(1) || [])); } catch (e) {}
        }
        if (roots.length === 0 && hook.renderers) {
            hook.renderers.forEach(function (_, id) {
                if (!all && roots.length > 0) return;
                try { add(Array.from(hook.getFiberRoots(id) || [])); } catch (e) {}
            });
        }
    }
    if (roots.length === 0 && typeof document !== 'undefined' && document) {
        var containerRoot = function (el) {
            if (!el) return null;
            var keys = Object.keys(el);
            for (var k = 0; k < keys.length; k++) {
                if (keys[k].indexOf('__reactContainer$') !== 0) continue;
                var f = el[keys[k]];
                return f ? (f.stateNode && f.stateNode.current ? f.stateNode : { current: f }) : null;
            }
            return null;
        };
        var seen = [];
        var scan = function (list) {
            for (var c = 0; c < list.length; c++) {
                if (!all && roots.length > 0) return;
                // #root is usually also one of body's children: read each element once.
                if (!list[c] || seen.indexOf(list[c]) >= 0) continue;
                seen.push(list[c]);
                var r = containerRoot(list[c]);
                if (r && roots.indexOf(r) < 0) roots.push(r);
            }
        };
        var candidates = [document.getElementById ? document.getElementById('root') : null];
        if (document.body) {
            candidates = candidates.concat(Array.from(document.body.children || []));
            candidates.push(document.body);
        }
        scan(candidates);
        // The usual spots missed: a container nested deeper (<div class="wrapper"><div id="app">).
        // ponytail: one Object.keys per element, only on a page where the fast path found nothing.
        if (roots.length === 0 && document.body && document.body.querySelectorAll) scan(Array.from(document.body.querySelectorAll('*')));
    }
    return roots;
}
function __eb_noRootsReason() {
    if (typeof document !== 'undefined' && document) return 'No fiber roots found on this page: it is not a React app, or React has not rendered yet.';
    return globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__
        ? 'No fiber roots found. The app may not have rendered yet.'
        : 'React DevTools hook not found. Make sure you are running a development build.';
}
`;
