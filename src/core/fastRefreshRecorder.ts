export const HMR_LOG_GLOBAL = "__rn_devtools_hmr_log__";
export const HMR_VIA_GLOBAL = "__rn_devtools_hmr_via__";
export const HMR_LOG_CAP = 32;

export type RecorderVia = "performReactRefresh" | "RefreshReg" | null;

export interface RefreshLogEntry {
    at: number;
    modulePath?: string;
}

export interface ReadRefreshLogMeta {
    justInstalled?: boolean;
    recorderInstalled: boolean;
    via: RecorderVia;
    reason?: string;
}

export interface ReadRefreshLogRawResult {
    lastUpdateAt: number | null;
    updateCount: number;
    recentUpdates: RefreshLogEntry[];
    _meta: ReadRefreshLogMeta;
}

// Body of the install IIFE — embedded both standalone (by
// buildRecorderInstallExpression) and inlined inside the read expression so a
// single executor round-trip can bootstrap the recorder on first use.
// Literal "32" matches HMR_LOG_CAP and is asserted by tests.
function installBody(): string {
    return `
var g = globalThis;
if (g.__rn_devtools_hmr_via__ !== undefined) {
    return { installed: true, via: g.__rn_devtools_hmr_via__ || null, alreadyInstalled: true };
}
g.__rn_devtools_hmr_log__ = [];
var arr = g.__rn_devtools_hmr_log__;
var push = function (entry) {
    arr.push(entry);
    while (arr.length > 32) arr.shift();
};
if (g.__ReactRefresh && typeof g.__ReactRefresh.performReactRefresh === 'function') {
    var original = g.__ReactRefresh.performReactRefresh.bind(g.__ReactRefresh);
    g.__ReactRefresh.performReactRefresh = function () {
        var r = original();
        push({ at: Date.now() });
        return r;
    };
    g.__rn_devtools_hmr_via__ = 'performReactRefresh';
    return { installed: true, via: 'performReactRefresh' };
}
if (typeof g.$RefreshReg$ === 'function') {
    var originalReg = g.$RefreshReg$;
    g.$RefreshReg$ = function (type, id) {
        originalReg(type, id);
        var modulePath;
        if (typeof id === 'string') {
            var sp = id.indexOf(' ');
            modulePath = sp === -1 ? id : id.slice(0, sp);
        }
        push({ at: Date.now(), modulePath: modulePath });
    };
    g.__rn_devtools_hmr_via__ = 'RefreshReg';
    return { installed: true, via: 'RefreshReg' };
}
g.__rn_devtools_hmr_via__ = null;
return { installed: false, via: null, reason: 'no __ReactRefresh and no $RefreshReg$' };
`;
}

export function buildRecorderInstallExpression(): string {
    return `(() => {${installBody()}})()`;
}

export function buildReadRefreshLogExpression(sincePath?: string, since?: number): string {
    if (typeof sincePath === "string" && sincePath.indexOf('"') !== -1) {
        throw new Error("sincePath must not contain double quotes");
    }

    const sincePathLiteral = sincePath === undefined ? "null" : JSON.stringify(sincePath);
    const sinceLiteral = since === undefined ? "null" : String(Math.trunc(since));

    return `(() => {
var __wasInstalled = globalThis.__rn_devtools_hmr_via__ !== undefined;
var __install = (function () {${installBody()}})();
var arr = Array.isArray(globalThis.__rn_devtools_hmr_log__) ? globalThis.__rn_devtools_hmr_log__ : [];
var sincePath = ${sincePathLiteral};
var since = ${sinceLiteral};
var filtered = arr.filter(function (e) {
    if (since !== null && !(e.at > since)) return false;
    if (sincePath !== null) {
        if (!e.modulePath) return false;
        if (e.modulePath.indexOf(sincePath) === -1) return false;
    }
    return true;
});
var lastUpdateAt = filtered.length ? filtered[filtered.length - 1].at : null;
var updateCount = filtered.length;
var recentUpdates = filtered.slice(-5).reverse();
var meta = {
    justInstalled: !__wasInstalled,
    recorderInstalled: __install.installed === true || __wasInstalled,
    via: __install.via != null ? __install.via : (globalThis.__rn_devtools_hmr_via__ || null)
};
if (__install.reason) meta.reason = __install.reason;
return { lastUpdateAt: lastUpdateAt, updateCount: updateCount, recentUpdates: recentUpdates, _meta: meta };
})()`;
}
