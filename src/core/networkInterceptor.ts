import WebSocket from "ws";
import { NetworkRequest } from "./types.js";
import { NetworkBuffer } from "./network.js";
import { getNextMessageId, getEpoch } from "./state.js";

/** Request bodies are capped before serialization — see REQUEST_BODY_CAP usage. */
export const REQUEST_BODY_CAP = 8 * 1024;
/** Response bodies share the app's console channel, so they are capped harder. */
export const RESPONSE_BODY_CAP = 32 * 1024;

/**
 * Returns a JS IIFE string that patches XMLHttpRequest and fetch
 * to capture network requests in React Native Bridgeless targets
 * where CDP Network.enable is unsupported.
 *
 * XHR is the source of truth: React Native's `fetch` is the whatwg-fetch
 * polyfill implemented on top of XMLHttpRequest, so a request that went
 * through `fetch` is *also* seen by the XHR layer. Reporting from both
 * would double-count every request under two different generated ids,
 * which the buffer cannot dedupe. The fetch wrapper therefore reports
 * only while the XHR patch is not installed (a JS context with no
 * XMLHttpRequest at all) and stays dormant otherwise.
 *
 * The XHR layer also sees what the fetch wrapper structurally cannot:
 * request headers, request body, response headers, response body,
 * content type, and the post-redirect URL.
 */
export function getInterceptorScript(): string {
    // Two-phase injection to capture both early and late requests:
    // Phase 1 (sync): Set __RN_NET_INJECTED__ flag and define helper functions.
    //   Patch XMLHttpRequest.prototype (this is the path axios takes).
    //   Install defineProperty setter trap on fetch — may or may not work on Hermes.
    // Phase 2 (setTimeout 0): After RN modules finish initializing, retry the XHR
    //   patch and wrap fetch. This is the reliable path that always works.
    return `(function() { try {
    if (globalThis.__RN_NET_INJECTED__) return;
    globalThis.__RN_NET_INJECTED__ = true;

    var _counter = 0;
    var _prefix = 'js-' + Math.random().toString(36).substring(2, 6) + '-';
    var _REQ_CAP = ${REQUEST_BODY_CAP};
    var _RES_CAP = ${RESPONSE_BODY_CAP};

    function _genId() {
      return _prefix + (++_counter);
    }

    function _report(evt) {
      // Suppressed when the in-app SDK is the source of truth — the MCP
      // flips this flag via Runtime.evaluate once it detects __RN_AI_DEVTOOLS__,
      // so the wrapper stops emitting debug lines and CDP traffic.
      if (globalThis.__RN_NET_DISABLED__) return;
      try {
        console.debug('__RN_NET__:' + JSON.stringify(evt));
      } catch(e) {}
    }

    // Bodies travel inline in a console.debug line shared with the app's own
    // output, so they are capped here rather than at read time.
    function _cap(s, limit) {
      if (typeof s !== 'string') return undefined;
      if (s.length <= limit) return s;
      return s.slice(0, limit) + '... [truncated ' + (s.length - limit) + ' bytes]';
    }

    function _bodyToString(b) {
      if (b === null || b === undefined) return undefined;
      try {
        if (typeof b === 'string') return b;
        if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
        if (typeof FormData !== 'undefined' && b instanceof FormData) return '[FormData]';
        if (typeof Blob !== 'undefined' && b instanceof Blob) {
          return '[binary body, ' + (typeof b.size === 'number' ? b.size : 0) + ' bytes]';
        }
        if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) {
          return '[binary body, ' + b.byteLength + ' bytes]';
        }
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(b)) {
          return '[binary body, ' + b.byteLength + ' bytes]';
        }
        if (typeof b === 'object') {
          // Duck-typed fallbacks: instanceof misses values built in another
          // realm, and String(binary) yields a useless '[object ArrayBuffer]'.
          if (typeof b.getParts === 'function') return '[FormData]';
          if (typeof b.byteLength === 'number') return '[binary body, ' + b.byteLength + ' bytes]';
          if (typeof b.size === 'number') return '[binary body, ' + b.size + ' bytes]';
          try { return JSON.stringify(b); } catch(e) {}
        }
        return String(b);
      } catch(e) { return undefined; }
    }

    function _parseHeaders(raw) {
      var out = {};
      if (typeof raw !== 'string' || raw.length === 0) return out;
      var lines = raw.split('\\n');
      for (var i = 0; i < lines.length; i++) {
        var idx = lines[i].indexOf(':');
        if (idx <= 0) continue;
        out[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
      }
      return out;
    }

    function _isTextual(ct) {
      if (!ct) return false;
      var v = String(ct).toLowerCase();
      return v.indexOf('json') >= 0 || v.indexOf('text/') === 0 || v.indexOf('xml') >= 0 ||
             v.indexOf('javascript') >= 0 || v.indexOf('x-www-form-urlencoded') >= 0;
    }

    function _responseBody(xhr) {
      try {
        var rt = xhr.responseType;
        if (rt === '' || rt === undefined || rt === 'text') return _cap(xhr.responseText, _RES_CAP);
        if (rt === 'json') return _cap(JSON.stringify(xhr.response), _RES_CAP);
        if (rt === 'arraybuffer') {
          var ab = xhr.response;
          return '[binary response, ' + ((ab && ab.byteLength) || 0) + ' bytes]';
        }
        if (rt === 'blob') {
          var b = xhr.response;
          return '[binary response, ' + ((b && b.size) || 0) + ' bytes]';
        }
        return undefined;
      } catch(e) { return undefined; }
    }

    // RN's fetch polyfill sets responseType='blob', so a JSON response arrives
    // as a Blob and responseText throws. Read it out of band and patch the
    // entry with a follow-up event rather than reporting a binary placeholder.
    function _readBlobText(id, blob) {
      try {
        var reader = new FileReader();
        reader.onload = function() {
          try {
            if (typeof reader.result === 'string') {
              _report({type: 'body', id: id, body: _cap(reader.result, _RES_CAP)});
            }
          } catch(e) {}
        };
        reader.readAsText(blob);
      } catch(e) {}
    }

    function _patchXHR() {
      try {
        if (typeof XMLHttpRequest === 'undefined') return false;
        var proto = XMLHttpRequest.prototype;
        if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') return false;
        if (proto.open.__rn_net_wrapped__) {
          // Already patched (phase 2 after phase 1). The flag still has to be
          // set, or the fetch wrapper would report alongside a live XHR layer.
          globalThis.__RN_NET_XHR_ACTIVE__ = true;
          return true;
        }

        var origOpen = proto.open;
        var origSend = proto.send;
        var origSetHeader = proto.setRequestHeader;
        var _states = (typeof WeakMap === 'function') ? new WeakMap() : null;

        function _getState(x) {
          try { return _states ? _states.get(x) : x.__rn_net_state__; } catch(e) { return undefined; }
        }
        function _setState(x, s) {
          try { if (_states) { _states.set(x, s); } else { x.__rn_net_state__ = s; } } catch(e) {}
        }

        var patchedOpen = function(method, url) {
          try {
            _setState(this, {
              id: _genId(),
              method: String(method === undefined || method === null ? 'GET' : method).toUpperCase(),
              url: (typeof url === 'string') ? url : String(url),
              headers: {},
              start: 0,
              done: false
            });
          } catch(e) {}
          return origOpen.apply(this, arguments);
        };
        patchedOpen.__rn_net_wrapped__ = true;
        proto.open = patchedOpen;

        if (typeof origSetHeader === 'function') {
          proto.setRequestHeader = function(name, value) {
            try {
              var s = _getState(this);
              if (s) s.headers[String(name)] = String(value);
            } catch(e) {}
            return origSetHeader.apply(this, arguments);
          };
        }

        proto.send = function(body) {
          var self = this;
          try {
            var s = _getState(self);
            if (s && !s.done && s.start === 0) {
              s.start = Date.now();
              _report({
                type: 'request',
                id: s.id,
                method: s.method,
                url: s.url,
                timestamp: s.start,
                headers: s.headers,
                body: _cap(_bodyToString(body), _REQ_CAP)
              });

              var _finish = function(kind, errText) {
                if (s.done) return;
                s.done = true;
                var duration = Date.now() - s.start;
                if (kind !== 'load') {
                  _report({type: 'error', id: s.id, error: errText, duration: duration});
                  return;
                }
                var evt = {
                  type: 'response',
                  id: s.id,
                  status: self.status,
                  statusText: self.statusText || '',
                  duration: duration
                };
                try {
                  var rh = (typeof self.getAllResponseHeaders === 'function')
                    ? _parseHeaders(self.getAllResponseHeaders()) : {};
                  evt.responseHeaders = rh;
                  if (rh['content-type']) evt.mimeType = rh['content-type'];
                  if (rh['content-length']) {
                    var cl = Number(rh['content-length']);
                    if (!isNaN(cl)) evt.contentLength = cl;
                  }
                } catch(e) {}
                try {
                  if (self.responseURL && self.responseURL !== s.url) evt.url = self.responseURL;
                } catch(e) {}
                var textualBlob = false;
                try {
                  textualBlob = self.responseType === 'blob' && _isTextual(evt.mimeType) &&
                    typeof FileReader !== 'undefined' && typeof Blob !== 'undefined' &&
                    self.response instanceof Blob;
                } catch(e) {}
                if (!textualBlob) evt.body = _responseBody(self);
                _report(evt);
                if (textualBlob) _readBlobText(s.id, self.response);
              };

              if (typeof self.addEventListener === 'function') {
                self.addEventListener('load', function() { _finish('load'); });
                self.addEventListener('error', function() { _finish('error', 'Network request failed'); });
                self.addEventListener('abort', function() { _finish('error', 'Request aborted'); });
                self.addEventListener('timeout', function() { _finish('error', 'Request timed out'); });
              }
            }
          } catch(e) {}
          return origSend.apply(self, arguments);
        };

        globalThis.__RN_NET_XHR_ACTIVE__ = true;
        return true;
      } catch(e) { return false; }
    }

    function _wrapFetch(origFetch) {
      if (typeof origFetch !== 'function') return origFetch;
      if (origFetch.__rn_net_wrapped__) return origFetch;

      var wrapped = function(input, init) {
        // Decided once per call, not per report: if the XHR patch lands
        // mid-flight, a request whose start was reported here must still
        // have its response reported here, or it hangs as 'pending' forever.
        var suppressed = !!globalThis.__RN_NET_XHR_ACTIVE__;
        // Don't burn an id on a suppressed call — it would leave gaps in the
        // sequence the XHR layer is handing out for the same requests.
        var id = suppressed ? '' : _genId();
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

        if (!suppressed) {
          _report({type: 'request', id: id, method: method, url: url, timestamp: startTime});
        }

        try {
          return origFetch.apply(globalThis, arguments).then(
            function(response) {
              try {
                if (!suppressed) {
                  var duration = Date.now() - startTime;
                  _report({type: 'response', id: id, status: response.status, statusText: response.statusText || '', duration: duration});
                }
              } catch(e) {}
              return response;
            },
            function(err) {
              try {
                if (!suppressed) {
                  var duration = Date.now() - startTime;
                  _report({type: 'error', id: id, error: (err && err.message) ? err.message : 'Fetch failed', duration: duration});
                }
              } catch(e) {}
              throw err;
            }
          );
        } catch(e) {
          try {
            if (!suppressed) {
              var duration = Date.now() - startTime;
              _report({type: 'error', id: id, error: (e && e.message) ? e.message : 'Fetch failed', duration: duration});
            }
          } catch(e2) {}
          throw e;
        }
      };
      wrapped.__rn_net_wrapped__ = true;
      return wrapped;
    }

    // Phase 1: patch XHR (axios and RN's own fetch polyfill both ride on it),
    // then try to trap fetch assignment via defineProperty (best-effort)
    _patchXHR();
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

    // Phase 2: retry XHR and wrap fetch after module init completes (reliable fallback)
    setTimeout(function() {
      try {
        _patchXHR();
      } catch(e) {}
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
 * Coerces a parsed JSON value into a header map. The interceptor builds these
 * from app-controlled input, so a non-object or a non-string value is dropped
 * rather than trusted.
 */
function toStringRecord(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (typeof val === "string") {
            out[key] = val;
        } else if (typeof val === "number" || typeof val === "boolean") {
            out[key] = String(val);
        }
    }
    return out;
}

/**
 * Parses an intercepted network event JSON string and routes it to the buffer.
 */
export function applyInterceptedEvent(
    jsonStr: string,
    networkBuffer: NetworkBuffer,
    deviceName: string
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
            headers: toStringRecord(event.headers),
            postData: typeof event.body === "string" ? event.body : undefined,
            completed: false,
            epoch: getEpoch(deviceName),
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

        // XHR-only fields. Absent on the fetch fallback path, so each is
        // applied only when present rather than overwriting with undefined.
        if (event.responseHeaders !== undefined) {
            existing.responseHeaders = toStringRecord(event.responseHeaders);
        }
        if (typeof event.mimeType === "string") {
            existing.mimeType = event.mimeType;
        }
        if (typeof event.contentLength === "number" && Number.isFinite(event.contentLength)) {
            existing.contentLength = event.contentLength;
        }
        if (typeof event.body === "string") {
            existing.responseBody = event.body;
        }
        // Post-redirect URL — xhr.responseURL, reported only when it differs.
        if (typeof event.url === "string" && event.url.length > 0) {
            existing.url = event.url;
        }

        networkBuffer.set(id, existing);
    } else if (type === "body") {
        // Out-of-band response body — RN's fetch polyfill delivers JSON as a
        // Blob, which the interceptor reads asynchronously after the response.
        const existing = networkBuffer.get(id);
        if (!existing) return;
        if (typeof event.body === "string") {
            existing.responseBody = event.body;
            networkBuffer.set(id, existing);
        }
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
