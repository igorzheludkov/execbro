import WebSocket from "ws";
import { NetworkRequest } from "./types.js";
import { NetworkBuffer } from "./network.js";
import { getNextMessageId } from "./state.js";

/**
 * Returns a JS IIFE string that patches XMLHttpRequest and fetch
 * to capture network requests in React Native Bridgeless targets
 * where CDP Network.enable is unsupported.
 */
export function getInterceptorScript(): string {
    // Two-phase injection to capture both early and late requests:
    // Phase 1 (sync): Set __RN_NET_INJECTED__ flag and define helper functions.
    //   Install defineProperty setter trap on fetch — may or may not work on Hermes.
    // Phase 2 (setTimeout 0): After RN modules finish initializing, wrap fetch.
    //   This is the reliable path that always works.
    return `(function() { try {
    if (globalThis.__RN_NET_INJECTED__) return;
    globalThis.__RN_NET_INJECTED__ = true;

    var _counter = 0;
    var _prefix = 'js-' + Math.random().toString(36).substring(2, 6) + '-';

    function _genId() {
      return _prefix + (++_counter);
    }

    function _report(evt) {
      try {
        console.debug('__RN_NET__:' + JSON.stringify(evt));
      } catch(e) {}
    }

    function _wrapFetch(origFetch) {
      if (typeof origFetch !== 'function') return origFetch;
      if (origFetch.__rn_net_wrapped__) return origFetch;

      var wrapped = function(input, init) {
        var id = _genId();
        var method = (init && init.method) ? init.method : 'GET';
        var url = '';
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input === 'object' && input.url) {
          url = String(input.url);
        } else {
          url = String(input);
        }
        var startTime = Date.now();

        _report({type: 'request', id: id, method: method, url: url, timestamp: startTime});

        try {
          return origFetch.apply(globalThis, arguments).then(
            function(response) {
              try {
                var duration = Date.now() - startTime;
                _report({type: 'response', id: id, status: response.status, statusText: response.statusText || '', duration: duration});
              } catch(e) {}
              return response;
            },
            function(err) {
              try {
                var duration = Date.now() - startTime;
                _report({type: 'error', id: id, error: (err && err.message) ? err.message : 'Fetch failed', duration: duration});
              } catch(e) {}
              throw err;
            }
          );
        } catch(e) {
          try {
            var duration = Date.now() - startTime;
            _report({type: 'error', id: id, error: (e && e.message) ? e.message : 'Fetch failed', duration: duration});
          } catch(e2) {}
          throw e;
        }
      };
      wrapped.__rn_net_wrapped__ = true;
      return wrapped;
    }

    // Phase 1: try to trap fetch assignment via defineProperty (best-effort)
    try {
      if (typeof globalThis.fetch === 'function') {
        globalThis.fetch = _wrapFetch(globalThis.fetch);
      }
      var _storedFetch = globalThis.fetch;
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        enumerable: true,
        get: function() { return _storedFetch; },
        set: function(v) { _storedFetch = _wrapFetch(v); }
      });
    } catch(e) {}

    // Phase 2: wrap fetch after module init completes (reliable fallback)
    setTimeout(function() {
      try {
        if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__rn_net_wrapped__) {
          globalThis.fetch = _wrapFetch(globalThis.fetch);
        }
      } catch(e) {}
    }, 0);

  } catch(e) {} })();`;
}

/**
 * Injects the network interceptor script into the app via Runtime.evaluate.
 * Fire-and-forget — does not wait for a response.
 */
export function injectNetworkInterceptor(ws: WebSocket): void {
    const message = JSON.stringify({
        id: getNextMessageId(),
        method: "Runtime.evaluate",
        params: {
            expression: getInterceptorScript(),
            silent: true,
        },
    });
    ws.send(message);
}

/**
 * Sends Network.enable CDP command. Returns the message ID used.
 */
export function sendNetworkEnable(ws: WebSocket): number {
    const id = getNextMessageId();
    const message = JSON.stringify({
        id,
        method: "Network.enable",
    });
    ws.send(message);
    return id;
}

/**
 * Checks if console event args contain a __RN_NET__: prefixed message.
 * Returns the JSON string after the prefix, or null.
 */
export function isInterceptorEvent(
    args: Array<{ type?: string; value?: unknown }>
): string | null {
    if (!args || args.length === 0) return null;

    const first = args[0];
    if (first.type !== "string" || typeof first.value !== "string") return null;

    const prefix = "__RN_NET__:";
    const val = first.value;
    if (!val.startsWith(prefix)) return null;

    return val.slice(prefix.length);
}

/**
 * Parses an intercepted network event JSON string and routes it to the buffer.
 */
export function applyInterceptedEvent(
    jsonStr: string,
    networkBuffer: NetworkBuffer
): void {
    let event: Record<string, unknown>;
    try {
        event = JSON.parse(jsonStr);
    } catch {
        return; // Invalid JSON — silently ignore
    }

    if (!event || typeof event !== "object" || !event.type || !event.id) {
        return;
    }

    const id = String(event.id);
    const type = event.type;

    if (type === "request") {
        const request: NetworkRequest = {
            requestId: id,
            timestamp: event.timestamp
                ? new Date(event.timestamp as number)
                : new Date(),
            method: String(event.method || "GET"),
            url: String(event.url || ""),
            headers: {},
            completed: false,
        };
        networkBuffer.set(id, request);
    } else if (type === "response") {
        const existing = networkBuffer.get(id);
        if (!existing) return; // No matching request — silently ignore

        const duration =
            typeof event.duration === "number" ? event.duration : undefined;

        existing.status = typeof event.status === "number" ? event.status : undefined;
        existing.statusText =
            typeof event.statusText === "string" ? event.statusText : undefined;
        existing.completed = true;
        existing.timing = {
            ...existing.timing,
            responseTime: Date.now(),
            duration,
        };
        networkBuffer.set(id, existing);
    } else if (type === "error") {
        const existing = networkBuffer.get(id);
        if (!existing) return; // No matching request — silently ignore

        const duration =
            typeof event.duration === "number" ? event.duration : undefined;

        existing.error =
            typeof event.error === "string" ? event.error : "Unknown error";
        existing.completed = true;
        existing.timing = {
            ...existing.timing,
            responseTime: Date.now(),
            duration,
        };
        networkBuffer.set(id, existing);
    }
}
