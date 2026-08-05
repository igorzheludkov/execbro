import { buildRequireSource } from "./moduleRegistry.js";

/** What the in-app script was able to do to NetInfo. */
export type NetInfoOutcome = "patched" | "reads-patched-only" | "not-installed" | "unknown";

/**
 * Makes NetInfo report offline, so an app whose offline UI is gated on
 * useNetInfo() actually renders it.
 *
 * Spiked 2026-08-05 against AppState (same shape: module-scoped singleton,
 * native-event driven, fans out to subscribers): a synthetic
 * RCTDeviceEventEmitter.emit updates the module's own state AND notifies
 * subscribers registered before the emit, reversibly.
 *
 * NetInfo's exact event name could not be verified — no app on hand installs it
 * — so this does not assume. It registers a probe subscriber, emits, and checks
 * whether the probe fired, returning one of:
 *   "patched"             - existing subscribers were notified
 *   "reads-patched-only"  - fetch() patched, existing subscribers were not
 *   "not-installed"       - NetInfo is absent, which is not an error
 *
 * ES5 only — this string is compiled by Hermes, not by tsc.
 */
export function buildNetInfoPatchScript(offline: boolean): string {
    const state = offline
        ? "{ type: 'none', isConnected: false, isInternetReachable: false, details: null }"
        : "{ type: 'unknown', isConnected: true, isInternetReachable: true, details: null }";

    return `(function() { try {
${buildRequireSource()}
  var NI = __eb_require('@react-native-community/netinfo');
  if (!NI || NI.__eb_error) return JSON.stringify({ netInfo: 'not-installed' });
  var mod = NI.default || NI;
  if (typeof mod.addEventListener !== 'function') return JSON.stringify({ netInfo: 'not-installed' });

  var state = ${state};

  // Registered BEFORE the emit so the outcome is measured, not assumed. The
  // native event name is the one thing the spike could not verify.
  var probeFired = false;
  var unsub = mod.addEventListener(function (s) {
    if (s && s.isConnected === state.isConnected) probeFired = true;
  });

  var DEE = __eb_require('react-native/Libraries/EventEmitter/RCTDeviceEventEmitter.js');
  var emitter = DEE && (DEE.default || DEE);
  if (emitter && typeof emitter.emit === 'function') {
    try { emitter.emit('netInfo.networkStatusDidChange', state); } catch (e) {}
  }

  if (typeof unsub === 'function') { try { unsub(); } catch (e) {} }

  // Going back online, undo any read patch a previous offline call installed.
  // A one-way patch would leave NetInfo lying for the rest of the session.
  if (${offline ? "false" : "true"}) {
    try {
      if (typeof mod.__eb_realFetch === 'function') {
        mod.fetch = mod.__eb_realFetch;
        mod.__eb_realFetch = undefined;
      }
    } catch (e) {}
    if (probeFired) return JSON.stringify({ netInfo: 'patched' });
    return JSON.stringify({ netInfo: 'reads-patched-only' });
  }

  if (probeFired) return JSON.stringify({ netInfo: 'patched' });

  // Fall back to patching reads so at least newly-mounted components are right.
  try {
    if (typeof mod.__eb_realFetch !== 'function') mod.__eb_realFetch = mod.fetch;
    mod.fetch = function () { return Promise.resolve(state); };
  } catch (e) {}
  return JSON.stringify({ netInfo: 'reads-patched-only' });
} catch (e) { return JSON.stringify({ netInfo: 'not-installed' }); } })()`;
}

/**
 * Reads the outcome back out of a Runtime.evaluate result.
 *
 * Anything unrecognised becomes "unknown" rather than a success value — the
 * whole point of the in-app self-verification is that this tool never claims to
 * have patched something it did not.
 */
export function parseNetInfoResult(raw: unknown): NetInfoOutcome {
    const valid: NetInfoOutcome[] = ["patched", "reads-patched-only", "not-installed"];
    let value: unknown = raw;

    // Depending on the evaluate path the JSON can arrive double-encoded.
    for (let i = 0; i < 2; i++) {
        if (typeof value !== "string") break;
        try {
            value = JSON.parse(value);
        } catch {
            return "unknown";
        }
    }

    if (value && typeof value === "object") {
        const found = (value as Record<string, unknown>).netInfo;
        if (typeof found === "string" && (valid as string[]).includes(found)) {
            return found as NetInfoOutcome;
        }
    }
    return "unknown";
}

/** Human-readable note for the tool response. Never overstates what happened. */
export function describeNetInfoOutcome(outcome: NetInfoOutcome): string {
    switch (outcome) {
        case "patched":
            return "NetInfo: patched — existing useNetInfo()/addEventListener subscribers were notified.";
        case "reads-patched-only":
            return (
                "NetInfo: reads-patched-only — NetInfo.fetch() now reports the new state, but existing " +
                "subscribers were NOT notified, so components already mounted may not re-render. " +
                "Request failure is unaffected."
            );
        case "not-installed":
            return "NetInfo: not-installed — the app does not use @react-native-community/netinfo. Request failure is unaffected.";
        default:
            return "NetInfo: unknown — the in-app check returned nothing usable. Assume NetInfo was NOT patched. Request failure is unaffected.";
    }
}
