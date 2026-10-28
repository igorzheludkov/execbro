/**
 * Records every React commit into globalThis.__eb_commits, from the very first
 * one after a reload.
 *
 * Sent on Runtime.executionContextCreated, which lands before the bundle runs
 * (about 450 ms early on the 2026-10-28 spike, while Metro serves the bundle).
 * At that point __REACT_DEVTOOLS_GLOBAL_HOOK__ does not exist, and it cannot be
 * pre-defined: react-devtools-core's installHook returns early when globalThis
 * already owns the property, which would turn React DevTools off. So until the
 * hook appears, Object.defineProperty is wrapped with a pass-through that
 * watches for that one define, restores itself, and wraps the hook. On the
 * spike this wrapped 47 ms after bundle start, ahead of the first commit at
 * 1180 ms, with React DevTools still attached.
 *
 * The slowest-component walk counts fibers that performed work in this commit
 * (flags & 1, React's PerformedWork, the test React DevTools uses) and descends
 * only where the child pointer changed. actualDuration > 0 is not a usable
 * prune: a bailed-out subtree keeps the previous commit's fibers and durations.
 *
 * ES5 only — this string is compiled by Hermes, not by tsc.
 */
export const COMMIT_RECORDER_JS = `(function () {
    var g = globalThis;
    var now = typeof g.nativePerformanceNow === 'function'
        ? g.nativePerformanceNow
        : function () { return g.performance.now(); };
    if (!Array.isArray(g.__eb_commits)) g.__eb_commits = [];
    if (typeof g.__eb_commits_dropped !== 'number') g.__eb_commits_dropped = 0;

    function nameOf(type) {
        if (!type) return null;
        if (typeof type === 'function') return type.displayName || type.name || null;
        if (type.displayName) return type.displayName;
        if (type.render) return nameOf(type.render);
        if (type.type) return nameOf(type.type);
        return null;
    }

    function slowestOf(first) {
        var best = null, bestMs = -1, visited = 0, stack = [first];
        while (stack.length && visited < 2000) {
            var f = stack.pop();
            if (!f) continue;
            visited++;
            var t = f.tag;
            if ((t === 0 || t === 1 || t === 11 || t === 14 || t === 15) && (f.flags & 1) === 1 &&
                typeof f.selfBaseDuration === 'number' && f.selfBaseDuration > bestMs) {
                var n = nameOf(f.type);
                if (n) { best = n; bestMs = f.selfBaseDuration; }
            }
            if (f.sibling) stack.push(f.sibling);
            if (f.child && (!f.alternate || f.child !== f.alternate.child)) stack.push(f.child);
        }
        return best ? { name: best, ms: bestMs } : null;
    }

    function record(root) {
        var current = root && root.current;
        var duration = current && typeof current.actualDuration === 'number' ? current.actualDuration : null;
        var slowest = duration === null ? null : slowestOf(current.child);
        var ring = g.__eb_commits;
        ring.push({ t: now(), duration: duration, slowest: slowest ? slowest.name : null, slowestMs: slowest ? slowest.ms : null });
        while (ring.length > 500) { ring.shift(); g.__eb_commits_dropped++; }
    }

    function wrap(hook) {
        if (!hook || hook.__eb_commitsWrapped || typeof hook.onCommitFiberRoot !== 'function') return;
        hook.__eb_commitsWrapped = true;
        var original = hook.onCommitFiberRoot;
        hook.onCommitFiberRoot = function (id, root) {
            var result = original.apply(this, arguments);
            try { record(root); } catch (e) {}
            return result;
        };
    }

    // Restores defineProperty only if it is still our trap: a polyfill that
    // replaced it after us keeps its own.
    function untrap() {
        if (!g.__eb_dp_orig) return;
        if (Object.defineProperty === g.__eb_dp_trap) Object.defineProperty = g.__eb_dp_orig;
        delete g.__eb_dp_orig;
        delete g.__eb_dp_trap;
    }

    // The hook can also arrive by plain assignment, or before its
    // onCommitFiberRoot exists. Re-injecting (the read does, once the bundle
    // has started) then wraps it and takes the trap down.
    if (g.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        untrap();
        wrap(g.__REACT_DEVTOOLS_GLOBAL_HOOK__);
    } else if (!g.__eb_dp_orig) {
        var dp = Object.defineProperty;
        var trap = function (target, key) {
            var result = dp.apply(this, arguments);
            if (target === g && key === '__REACT_DEVTOOLS_GLOBAL_HOOK__') {
                untrap();
                try { wrap(g.__REACT_DEVTOOLS_GLOBAL_HOOK__); } catch (e) {}
            }
            return result;
        };
        g.__eb_dp_orig = dp;
        g.__eb_dp_trap = trap;
        Object.defineProperty = trap;
    }
    return true;
})()`;
