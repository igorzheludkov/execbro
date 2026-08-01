/**
 * The single fiber resolver for text inputs.
 *
 * Replaces the three copy-pasted walkers that lived in focusedInput.ts and
 * fixes both of their blind spots — each of which made the tools report
 * "no focused TextInput" while a field WAS focused:
 *
 *   1. They took roots[0] and stopped, hiding inputs mounted under a second
 *      fiber root (modal and portal roots).
 *   2. They read stateNode.canonical.publicInstance unconditionally, which is
 *      Fabric-only. Paper exposes the instance as stateNode itself.
 *
 * The emitted source is compiled by Hermes, not tsc: no async/await, and no
 * require() beyond the injected __eb_require. Non-ASCII in embedded literals is
 * escaped server-side by executeInApp, so values go in via JSON.stringify.
 */

export type InputQuery = {
    testID?: string;
    component?: string;
    textMatch?: string;
};

export type InputOp =
    | { kind: "find" }
    | { kind: "focus" }
    | { kind: "read" }
    | { kind: "setValue"; value: string }
    | { kind: "clear" }
    | { kind: "blur" };

export type InputFound = {
    found: true;
    focused: boolean;
    nativeTag: number | null;
    value: string | null;
    hasOnChangeText: boolean;
    ok: boolean;
    via?: string;
};

export type InputMissing = {
    found: false;
    reason: string;
    candidates?: string[];
};

export type InputResult = InputFound | InputMissing;

const HOST_INPUT_TYPES = `["RCTSinglelineTextInputView","RCTMultilineTextInputView","AndroidTextInput"]`;

const NO_FOCUS_REASON =
    "no focused TextInput. Pass testID (or component) so this tool can focus a field itself, " +
    "or tap the field first. A tap reporting success does not guarantee React focus.";

/** Collects every root, defines the shape-tolerant helpers, resolves __eb_host. */
function prelude(query: InputQuery | undefined): string {
    const wantTestID = query?.testID != null ? JSON.stringify(query.testID) : "null";
    const wantComponent = query?.component != null ? JSON.stringify(query.component) : "null";
    const wantText = query?.textMatch != null ? JSON.stringify(query.textMatch) : "null";

    return `
  var hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { found: false, reason: "no devtools hook" };

  var allRoots = [];
  var rendererIds = Array.from(hook.renderers.keys());
  for (var ri = 0; ri < rendererIds.length; ri++) {
    var rs = Array.from(hook.getFiberRoots(rendererIds[ri]) || []);
    for (var rj = 0; rj < rs.length; rj++) allRoots.push(rs[rj]);
  }
  if (allRoots.length === 0) return { found: false, reason: "no fiber roots" };

  var HOSTS = ${HOST_INPUT_TYPES};
  var wantTestID = ${wantTestID};
  var wantComponent = ${wantComponent};
  var wantText = ${wantText};

  function __eb_name(t) { return typeof t === "string" ? t : (t && (t.displayName || t.name)) || null; }

  function __eb_pub(f) {
    var sn = f && f.stateNode;
    if (!sn) return null;
    if (sn.canonical && sn.canonical.publicInstance) return sn.canonical.publicInstance;
    if (sn.canonical) return sn.canonical;
    return sn;
  }

  function __eb_owner(hostFiber) {
    for (var p = hostFiber; p; p = p.return) {
      if (p.memoizedProps && typeof p.memoizedProps.onChangeText === "function") return p;
    }
    return null;
  }

  // Nearest testID at or above the host, so a testID set on the RN <TextInput>
  // wrapper still matches its host descendant.
  function __eb_testIDOf(hostFiber) {
    for (var p = hostFiber; p; p = p.return) {
      var mp = p.memoizedProps;
      if (mp && (mp.testID || mp.nativeID)) return mp.testID || mp.nativeID;
    }
    return null;
  }

  function __eb_componentOf(hostFiber) {
    for (var p = hostFiber; p; p = p.return) {
      var n = __eb_name(p.type);
      if (n && n.length > 0 && HOSTS.indexOf(n) === -1) return n;
    }
    return null;
  }

  var __eb_inputs = [];
  for (var k = 0; k < allRoots.length; k++) {
    (function walk(f, depth) {
      if (!f || depth > 600) return;
      if (HOSTS.indexOf(__eb_name(f.type)) !== -1) __eb_inputs.push(f);
      if (f.child) walk(f.child, depth + 1);
      if (f.sibling) walk(f.sibling, depth);
    })(allRoots[k].current, 0);
  }
  if (__eb_inputs.length === 0) return { found: false, reason: "no TextInput found on screen" };

  var __eb_host = null;
  var i;
  if (wantTestID !== null) {
    for (i = 0; i < __eb_inputs.length; i++) {
      if (__eb_testIDOf(__eb_inputs[i]) === wantTestID) { __eb_host = __eb_inputs[i]; break; }
    }
  } else if (wantComponent !== null) {
    var wc = String(wantComponent).toLowerCase();
    for (i = 0; i < __eb_inputs.length; i++) {
      var cn = __eb_componentOf(__eb_inputs[i]);
      if (cn && cn.toLowerCase().indexOf(wc) !== -1) { __eb_host = __eb_inputs[i]; break; }
    }
  } else if (wantText !== null) {
    var wt = String(wantText).toLowerCase();
    for (i = 0; i < __eb_inputs.length; i++) {
      var o = __eb_owner(__eb_inputs[i]);
      var mp2 = o ? o.memoizedProps : {};
      var hay = String((mp2.value || "") + " " + (mp2.placeholder || "")).toLowerCase();
      if (hay.indexOf(wt) !== -1) { __eb_host = __eb_inputs[i]; break; }
    }
  } else {
    for (i = 0; i < __eb_inputs.length; i++) {
      var pf = __eb_pub(__eb_inputs[i]);
      if (pf && pf.isFocused && pf.isFocused()) { __eb_host = __eb_inputs[i]; break; }
    }
  }

  if (!__eb_host) {
    var candidates = [];
    for (var c = 0; c < __eb_inputs.length && candidates.length < 8; c++) {
      var tid = __eb_testIDOf(__eb_inputs[c]);
      if (tid && candidates.indexOf(tid) === -1) candidates.push(tid);
    }
    var targeted = (wantTestID !== null || wantComponent !== null || wantText !== null);
    return {
      found: false,
      reason: targeted
        ? ("no TextInput matched that target (" + __eb_inputs.length + " input(s) on screen)")
        : ${JSON.stringify(NO_FOCUS_REASON)},
      candidates: candidates
    };
  }

  var __eb_ownerFiber = __eb_owner(__eb_host);
  var __eb_pubi = __eb_pub(__eb_host);
  var __eb_value = __eb_ownerFiber && __eb_ownerFiber.memoizedProps.value != null
    ? String(__eb_ownerFiber.memoizedProps.value) : null;
  var __eb_focused = !!(__eb_pubi && __eb_pubi.isFocused && __eb_pubi.isFocused());
  var __eb_tag = __eb_pubi && __eb_pubi.__nativeTag != null ? __eb_pubi.__nativeTag : null;
`;
}

/** The always-present fields of a found result. */
const BASE = `
    found: true,
    focused: __eb_focused,
    nativeTag: __eb_tag,
    value: __eb_value,
    hasOnChangeText: !!__eb_ownerFiber`;

export function buildInputExpression(op: InputOp, query?: InputQuery): string {
    let action: string;

    switch (op.kind) {
        case "find":
        case "read":
            action = `
  return { ${BASE}, ok: true };`;
            break;

        case "focus":
            action = `
  if (__eb_pubi && typeof __eb_pubi.focus === "function") {
    __eb_pubi.focus();
    return { ${BASE}, focused: true, ok: true, via: "publicInstance.focus" };
  }
  return { ${BASE}, ok: false, via: "input exposes no focus() method" };`;
            break;

        case "blur":
            action = `
  if (__eb_pubi && typeof __eb_pubi.blur === "function") {
    __eb_pubi.blur();
    return { ${BASE}, focused: false, ok: true, via: "publicInstance.blur" };
  }
  return { ${BASE}, ok: false, via: "input exposes no blur() method" };`;
            break;

        case "setValue":
            action = `
  var next = ${JSON.stringify(op.value)};
  if (__eb_ownerFiber) {
    __eb_ownerFiber.memoizedProps.onChangeText(next);
    return { ${BASE}, value: next, ok: true, via: "onChangeText" };
  }
  return { ${BASE}, ok: false, via: "no onChangeText (uncontrolled input)" };`;
            break;

        case "clear":
            action = `
  if (__eb_ownerFiber) {
    __eb_ownerFiber.memoizedProps.onChangeText("");
    return { ${BASE}, value: "", ok: true, via: "onChangeText" };
  }
  if (__eb_pubi && typeof __eb_pubi.clear === "function") {
    __eb_pubi.clear();
    return { ${BASE}, value: "", ok: true, via: "publicInstance.clear" };
  }
  return { ${BASE}, ok: false, via: "input exposes no clear() method" };`;
            break;
    }

    return `(() => {${prelude(query)}${action}
})()`;
}
