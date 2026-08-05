import WebSocket from "ws";
import { NetworkRequest } from "./types.js";
import { NetworkBuffer } from "./network.js";
import { getNextMessageId, getEpoch } from "./state.js";
import { recordHit } from "./mockRules.js";

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
      _reportAlways(evt);
    }

    // Mock events bypass the SDK suppression gate. That flag exists so two
    // capture layers do not both report the same request; a mock is not
    // captured traffic, and the SDK knows nothing about it. Suppressing it
    // would hide altered traffic from the agent and freeze every server-side
    // hit counter at zero — the one thing a mock must never do.
    function _reportAlways(evt) {
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

    // ---- mock layer ------------------------------------------------------
    // Rules are pushed from the server (buildMockPushScript). Never reset here:
    // a re-injection into a live context must not drop them.
    if (!globalThis.__RN_NET_MOCKS__) globalThis.__RN_NET_MOCKS__ = [];

    function _ruleMatches(rule, method, url) {
      try {
        if (rule.method && String(rule.method).toUpperCase() !== method) return false;
        var pat = String(rule.url === undefined || rule.url === null ? '' : rule.url);
        if (pat.length > 1 && pat.charAt(0) === '/' && pat.charAt(pat.length - 1) === '/') {
          // Slash-wrapped means regex. Compiled per call rather than cached:
          // the rule list is short and re-pushed on every context creation.
          // The server rejects catastrophic patterns before they get here.
          return new RegExp(pat.slice(1, -1)).test(url);
        }
        return url.indexOf(pat) !== -1;
      } catch (e) { return false; }
    }

    function _matchRule(method, url) {
      var rules = globalThis.__RN_NET_MOCKS__;
      if (!rules || !rules.length) return null;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (!r || r.__spent) continue;
        if (_ruleMatches(r, method, url)) {
          if (typeof r.times === 'number') {
            r.__used = (r.__used || 0) + 1;
            if (r.__used >= r.times) r.__spent = true;
          }
          return r;
        }
      }
      return null;
    }

    // A plain assignment is silently dropped when the prototype exposes a
    // getter with no setter — which is exactly how React Native's
    // XMLHttpRequest defines responseText and response. Verify the write took
    // and fall back to an own data property, which shadows the accessor.
    function _setProp(obj, name, value) {
      try {
        obj[name] = value;
        if (obj[name] === value) return;
      } catch (e) {}
      try {
        Object.defineProperty(obj, name, {
          configurable: true, enumerable: true, writable: true, value: value
        });
      } catch (e) {}
    }

    function _headersToText(headers) {
      var out = '';
      if (!headers || typeof headers !== 'object') return out;
      try {
        for (var k in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, k)) {
            out += String(k).toLowerCase() + ': ' + String(headers[k]) + '\\r\\n';
          }
        }
      } catch (e) {}
      return out;
    }

    // getAllResponseHeaders / getResponseHeader are methods, not properties, so
    // _setProp cannot reach them. Shadow them per instance for this response.
    function _installMockHeaders(xhr, headersText) {
      try {
        var text = headersText || '';
        Object.defineProperty(xhr, 'getAllResponseHeaders', {
          configurable: true, enumerable: false, writable: true,
          value: function () { return text; }
        });
        Object.defineProperty(xhr, 'getResponseHeader', {
          configurable: true, enumerable: false, writable: true,
          value: function (name) {
            var v = _parseHeaders(text)[String(name).toLowerCase()];
            return (v === undefined) ? null : v;
          }
        });
      } catch (e) {}
    }

    // Fires the on<event> property handler and every addEventListener listener,
    // which is what a real XHR does. dispatchEvent is deliberately not used:
    // RN's EventTarget rejects a plain object, and the listener list below is
    // complete because addEventListener is patched on the prototype.
    function _fire(xhr, type) {
      try {
        var evt = { type: type, target: xhr, currentTarget: xhr };
        var prop = xhr['on' + type];
        if (typeof prop === 'function') { try { prop.call(xhr, evt); } catch (e) {} }
        var ls = xhr.__rn_net_listeners__ && xhr.__rn_net_listeners__[type];
        if (ls) {
          var copy = ls.slice();
          for (var i = 0; i < copy.length; i++) {
            try { copy[i].call(xhr, evt); } catch (e) {}
          }
        }
      } catch (e) {}
    }

    /**
     * Writes a synthetic response onto the app's own XHR and fires its
     * handlers, so the app reads mocked values through the normal API.
     * Also emits the terminal capture event — without it the request would sit
     * in the buffer as pending forever.
     */
    function _deliverMock(xhr, rule, s, bodyText, statusOverride, headersText, warning) {
      var go = function () {
        try {
          var duration = Date.now() - s.start;
          s.done = true;
          if (rule.networkError) {
            _setProp(xhr, 'readyState', 4);
            _setProp(xhr, 'status', 0);
            _setProp(xhr, 'statusText', '');
            _reportAlways({ type: 'mock', id: s.id, ruleId: rule.id, warning: warning });
            _report({ type: 'error', id: s.id, error: String(rule.networkError), duration: duration });
            _fire(xhr, 'readystatechange');
            _fire(xhr, 'error');
            _fire(xhr, 'loadend');
            return;
          }
          var text = (bodyText === null || bodyText === undefined) ? '' : String(bodyText);
          var status = (typeof statusOverride === 'number') ? statusOverride : 200;
          var text2 = headersText || '';
          _setProp(xhr, 'readyState', 4);
          _setProp(xhr, 'status', status);
          _setProp(xhr, 'statusText', '');
          _setProp(xhr, 'responseText', text);
          _setProp(xhr, 'response', text);
          _installMockHeaders(xhr, text2);
          _reportAlways({ type: 'mock', id: s.id, ruleId: rule.id, warning: warning });
          var evt = {
            type: 'response', id: s.id, status: status, statusText: '',
            duration: duration, responseHeaders: _parseHeaders(text2),
            body: _cap(text, _RES_CAP)
          };
          if (evt.responseHeaders['content-type']) evt.mimeType = evt.responseHeaders['content-type'];
          _report(evt);
          _fire(xhr, 'readystatechange');
          _fire(xhr, 'load');
          _fire(xhr, 'loadend');
        } catch (e) {}
      };
      // Always deferred, never synchronous: a real XHR response never arrives
      // inside send(), and code that assumes it does breaks in surprising ways.
      var delay = (typeof rule.delayMs === 'number' && rule.delayMs > 0) ? rule.delayMs : 0;
      setTimeout(go, delay);
    }
    function _setPath(obj, path, value) {
      var parts = String(path).split('.');
      var cur = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }

    function _removePath(obj, path) {
      var parts = String(path).split('.');
      var cur = obj;
      for (var i = 0; i < parts.length - 1; i++) {
        if (cur === null || typeof cur !== 'object') return;
        cur = cur[parts[i]];
      }
      if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
    }

    /**
     * Returns { body, warning }. A non-JSON body is passed through untouched
     * with a warning rather than replaced: handing the app a mangled body would
     * turn a tamper into a parse error the agent then has to debug.
     */
    function _applyTamper(rule, bodyText) {
      if (typeof rule.bodyReplace === 'string') return { body: rule.bodyReplace };
      var wantsJson = rule.set || rule.remove;
      if (!wantsJson) return { body: bodyText };
      var parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch (e) {
        return { body: bodyText, warning: 'tamper skipped - response was not JSON' };
      }
      try {
        if (rule.remove) {
          for (var i = 0; i < rule.remove.length; i++) _removePath(parsed, rule.remove[i]);
        }
        if (rule.set) {
          for (var k in rule.set) {
            if (Object.prototype.hasOwnProperty.call(rule.set, k)) _setPath(parsed, k, rule.set[k]);
          }
        }
        return { body: JSON.stringify(parsed) };
      } catch (e) {
        return { body: bodyText, warning: 'tamper failed: ' + String(e && e.message ? e.message : e) };
      }
    }
    // ---- end mock layer --------------------------------------------------

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

        // Recorded so _fire can reach the app's handlers when a mock replaces
        // the response. There is no other way to enumerate them.
        var origAddEventListener = proto.addEventListener;
        if (typeof origAddEventListener === 'function') {
          proto.addEventListener = function(type, fn) {
            try {
              if (!this.__rn_net_listeners__) this.__rn_net_listeners__ = {};
              if (!this.__rn_net_listeners__[type]) this.__rn_net_listeners__[type] = [];
              this.__rn_net_listeners__[type].push(fn);
            } catch(e) {}
            return origAddEventListener.apply(this, arguments);
          };
        }

        /**
         * Runs the real request on a second XHR so the app's own request never
         * reaches the wire, then hands the app a response we synthesized.
         *
         * This is what removes the listener-ordering hazard. Letting the app's
         * request fly and mutating it in a load listener does not work: apps
         * commonly assign xhr.onload BEFORE send(), and a property handler runs
         * ahead of any listener added afterwards, so the app would read the
         * untampered response.
         *
         * Lives inside _patchXHR because it must call the ORIGINAL open/send —
         * a shadow that went through the patched ones would be reported as a
         * second request and could match a rule itself.
         */
        var _shadowFetch = function(appXhr, s, rule, body) {
          try {
            var shadow = new XMLHttpRequest();
            origOpen.call(shadow, s.method, s.url);
            if (typeof origSetHeader === 'function') {
              for (var name in s.headers) {
                if (Object.prototype.hasOwnProperty.call(s.headers, name)) {
                  try { origSetHeader.call(shadow, name, s.headers[name]); } catch (e) {}
                }
              }
            }
            var done = false;
            var onDone = function() {
              if (done) return;
              done = true;
              var real = '';
              try { real = shadow.responseText || ''; } catch (e) {}
              var out = _applyTamper(rule, real);
              var headersText = '';
              try {
                headersText = (typeof shadow.getAllResponseHeaders === 'function')
                  ? shadow.getAllResponseHeaders() : '';
              } catch (e) {}
              var status = (typeof rule.status === 'number') ? rule.status : shadow.status;
              _deliverMock(appXhr, rule, s, out.body, status, headersText, out.warning);
            };
            var onFail = function() {
              if (done) return;
              done = true;
              _deliverMock(appXhr, { id: rule.id, networkError: 'Network request failed' },
                s, null, 0, '', 'shadow request failed');
            };
            if (typeof shadow.addEventListener === 'function') {
              shadow.addEventListener('load', onDone);
              shadow.addEventListener('error', onFail);
              shadow.addEventListener('abort', onFail);
              shadow.addEventListener('timeout', onFail);
            }
            origSend.call(shadow, body);
          } catch (e) {
            _deliverMock(appXhr, { id: rule.id, networkError: 'Network request failed' },
              s, null, 0, '', 'shadow request threw');
          }
        };

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

              var _rule = _matchRule(s.method, s.url);
              if (_rule) {
                s.mocked = true;
                if (_rule.mode === 'tamper') {
                  _shadowFetch(self, s, _rule, body);
                } else {
                  _deliverMock(self, _rule, s, _rule.body, _rule.status,
                    _headersToText(_rule.headers), undefined);
                }
                // The app's request never reaches the wire: returning here is
                // what makes the mock authoritative rather than a race with
                // the real response.
                return;
              }

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
 * Script that replaces the app's rule list wholesale. Wholesale rather than
 * incremental because the server is authoritative — a diff protocol would let
 * the two drift with no way to notice.
 *
 * The one thing carried across a push is each rule's `times` budget, keyed by
 * id. Rules are re-pushed on every mutation, so without this, adding a second
 * rule would silently rearm a spent `times: 1` rule and break the retry test it
 * exists for. A brand new JS context starts with no previous list, so a reload
 * legitimately rearms every budget — a reload is a new app run.
 */
export function buildMockPushScript(rulesJson: string): string {
    return `(function(){ try {
  var __eb_prev = globalThis.__RN_NET_MOCKS__ || [];
  var __eb_next = ${rulesJson};
  var __eb_byId = {};
  for (var __eb_i = 0; __eb_i < __eb_prev.length; __eb_i++) {
    if (__eb_prev[__eb_i] && __eb_prev[__eb_i].id) __eb_byId[__eb_prev[__eb_i].id] = __eb_prev[__eb_i];
  }
  for (var __eb_j = 0; __eb_j < __eb_next.length; __eb_j++) {
    var __eb_old = __eb_byId[__eb_next[__eb_j].id];
    if (__eb_old) {
      __eb_next[__eb_j].__used = __eb_old.__used;
      __eb_next[__eb_j].__spent = __eb_old.__spent;
    }
  }
  globalThis.__RN_NET_MOCKS__ = __eb_next;
} catch(e) { try { globalThis.__RN_NET_MOCKS__ = ${rulesJson}; } catch(e2) {} } })();`;
}

/**
 * Pushes the current rule list to the app. Fire-and-forget — the server stays
 * authoritative, so a dropped push is corrected by the next mutation or by the
 * re-push on the next execution context.
 */
export function pushMockRules(ws: WebSocket, rulesJson: string): void {
    ws.send(
        JSON.stringify({
            id: getNextMessageId(),
            method: "Runtime.evaluate",
            params: { expression: buildMockPushScript(rulesJson), silent: true },
        })
    );
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
    } else if (type === "mock") {
        // The hit count is server-owned and keyed only by rule id, so it is
        // recorded even when the request itself is not in this buffer — under
        // the SDK the buffer is mirrored and carries SDK ids, but the rule
        // still fired and a silently-zero counter would read as "never matched".
        if (typeof event.ruleId === "string") recordHit(deviceName, event.ruleId);

        const existing = networkBuffer.get(id);
        if (!existing) return;
        existing.mocked = true;
        if (typeof event.ruleId === "string") existing.mockId = event.ruleId;
        if (typeof event.warning === "string") existing.mockWarning = event.warning;
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
