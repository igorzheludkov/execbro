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
    /** Matches the input's value, placeholder, accessibilityLabel or visible field label. */
    textMatch?: string;
    /** Zero-based choice among matches. Required when a target matches more than one input. */
    index?: number;
};

/** What an agent needs to tell two inputs apart and target the right one. */
export type InputCandidate = {
    index: number;
    component: string | null;
    label: string | null;
    placeholder: string | null;
    value: string | null;
    testID: string | null;
};

import { RN_PRIMITIVES_SRC, GENERIC_COMPONENT_SRC } from "./injectedFilters.js";

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
    /** The resolved field's testID, so a native read-back can find the same one. */
    testID: string | null;
    /**
     * True when the field's value prop mirrors its text — the only way to read
     * it back from JS, and therefore the only way a write can be verified.
     */
    controlled: boolean;
    hasOnChangeText: boolean;
    ok: boolean;
    via?: string;
};

export type InputMissing = {
    found: false;
    reason: string;
    /** True when the target matched several inputs and none was chosen. */
    ambiguous?: boolean;
    candidates?: InputCandidate[];
    /**
     * How many inputs exist in total. The candidate list is capped, and a cap
     * that is not reported reads as "this is everything" — which is how a
     * caller concludes the field it wants is absent when it is simply beyond
     * the cut.
     */
    totalInputs?: number;
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

  var RN_PRIMITIVES = ${RN_PRIMITIVES_SRC};
  var GENERIC_COMPONENT = ${GENERIC_COMPONENT_SRC};

  // The fiber whose onChangeText we call and whose value we read: the INNERMOST
  // composite carrying it. Host fibers are skipped — props are spread down to
  // them, so the host's onChangeText is the same function reached one level up,
  // but only the composite is a documented RN contract of (text: string).
  function __eb_owner(hostFiber) {
    for (var p = hostFiber; p; p = p.return) {
      if (typeof p.type === "string") continue;
      if (p.memoizedProps && typeof p.memoizedProps.onChangeText === "function") return p;
    }
    return null;
  }

  // The field wrapper — the OUTERMOST ancestor still carrying onChangeText.
  //
  // A generic capped climb cannot find this. Measured on a real form: the
  // wrapper (FormInput) sits 10 levels above the host behind four plain Views,
  // so a 4-composite budget is spent on Views long before reaching it, and
  // every input resolves to nothing. get_screen_state only names it because it
  // matches that fiber directly. onChangeText is the signal that separates a
  // field's own wrapper from the layout Views around it.
  function __eb_fieldFiber(hostFiber) {
    var best = null;
    var p = hostFiber;
    var d = 0;
    while (p && d < 30) {
      if (typeof p.type !== "string" && p.memoizedProps &&
          typeof p.memoizedProps.onChangeText === "function") {
        var n = __eb_name(p.type);
        if (n && !RN_PRIMITIVES.test(n) && !GENERIC_COMPONENT.test(n)) best = p;
      }
      p = p.return;
      d++;
    }
    return best;
  }

  // testID at the host or its controlling owner ONLY — never an arbitrary
  // ancestor. Climbing freely picks up a ScrollView's internal nativeID: on a
  // 7-field form every input answered to testID "7", so one target matched
  // them all. nativeID is accepted only as a fallback on those same two fibers.
  function __eb_testIDOf(hostFiber) {
    var owner = __eb_owner(hostFiber);
    var scope = owner && owner !== hostFiber ? [hostFiber, owner] : [hostFiber];
    var s;
    for (s = 0; s < scope.length; s++) {
      var mp = scope[s].memoizedProps;
      if (mp && mp.testID) return mp.testID;
    }
    for (s = 0; s < scope.length; s++) {
      var mp2 = scope[s].memoizedProps;
      if (mp2 && mp2.nativeID) return mp2.nativeID;
    }
    return null;
  }

  // The authored component name. Prefer the field wrapper; fall back to the
  // capped composite climb get_screen_state uses for inputs that have no
  // wrapper of their own. The filters matter either way — without them every
  // input reports "TextAncestorContext", which names nothing and matches all.
  function __eb_componentFiber(hostFiber) {
    var field = __eb_fieldFiber(hostFiber);
    if (field) return field;
    var an = hostFiber.return;
    var composites = 0;
    var dep = 0;
    while (an && dep < 12 && composites < 4) {
      if (typeof an.type !== "string" && an.type !== null) {
        var n = __eb_name(an.type);
        if (n) {
          composites++;
          if (!RN_PRIMITIVES.test(n) && !GENERIC_COMPONENT.test(n)) return an;
        }
      }
      an = an.return;
      dep++;
    }
    return null;
  }

  function __eb_componentOf(hostFiber) {
    var cf = __eb_componentFiber(hostFiber);
    return cf ? __eb_name(cf.type) : null;
  }

  // The field's visible label — the text the wrapper renders beside the input
  // ("First Name"), which is how a human identifies a field and how
  // get_screen_state prints it. Host input subtrees are skipped so a field's
  // own value never becomes its label.
  function __eb_labelOf(hostFiber) {
    var cf = __eb_componentFiber(hostFiber);
    if (!cf) return null;
    var parts = [];
    (function collect(f, d) {
      if (!f || d > 14 || parts.length >= 4) return;
      // Never descend into an input: a field's own value must not become its label.
      if (HOSTS.indexOf(__eb_name(f.type)) !== -1) return;
      var mp = f.memoizedProps;
      if (mp && typeof mp.children === "string" && mp.children.trim().length > 0) {
        // Take the outermost fiber of a text branch and stop. A single label
        // repeats down its Text -> RCTText chain, which otherwise renders as
        // "Title Title Title *".
        parts.push(mp.children.trim());
        if (f.sibling) collect(f.sibling, d);
        return;
      }
      if (f.child) collect(f.child, d + 1);
      if (f.sibling) collect(f.sibling, d);
    })(cf.child, 0);
    return parts.length ? parts.join(" ").slice(0, 80) : null;
  }

  function __eb_describe(hostFiber, idx) {
    var o = __eb_owner(hostFiber);
    var op = o ? o.memoizedProps : {};
    return {
      index: idx,
      component: __eb_componentOf(hostFiber),
      label: __eb_labelOf(hostFiber),
      placeholder: op.placeholder != null ? String(op.placeholder) : null,
      value: op.value != null ? String(op.value) : null,
      testID: __eb_testIDOf(hostFiber)
    };
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

  // EVERY match is collected. Taking the first silently is how a form gets the
  // right text written into the wrong field and still verifies clean — the
  // exact class of confident-but-wrong result this tool exists to remove.
  var __eb_matches = [];
  var i;
  if (wantTestID !== null) {
    for (i = 0; i < __eb_inputs.length; i++) {
      if (__eb_testIDOf(__eb_inputs[i]) === wantTestID) __eb_matches.push(__eb_inputs[i]);
    }
  } else if (wantComponent !== null) {
    var wc = String(wantComponent).toLowerCase();
    for (i = 0; i < __eb_inputs.length; i++) {
      var cn = __eb_componentOf(__eb_inputs[i]);
      if (cn && cn.toLowerCase().indexOf(wc) !== -1) __eb_matches.push(__eb_inputs[i]);
    }
  } else if (wantText !== null) {
    var wt = String(wantText).toLowerCase();
    for (i = 0; i < __eb_inputs.length; i++) {
      var o = __eb_owner(__eb_inputs[i]);
      var mp3 = o ? o.memoizedProps : {};
      var hay = String(
        (mp3.value || "") + " " + (mp3.placeholder || "") + " " +
        (mp3.accessibilityLabel || "") + " " + (__eb_labelOf(__eb_inputs[i]) || "")
      ).toLowerCase();
      if (hay.indexOf(wt) !== -1) __eb_matches.push(__eb_inputs[i]);
    }
  } else {
    for (i = 0; i < __eb_inputs.length; i++) {
      var pf = __eb_pub(__eb_inputs[i]);
      if (pf && pf.isFocused && pf.isFocused()) __eb_matches.push(__eb_inputs[i]);
    }
  }

  var targeted = (wantTestID !== null || wantComponent !== null || wantText !== null);

  if (__eb_matches.length === 0) {
    var candidates = [];
    for (var c = 0; c < __eb_inputs.length && candidates.length < 12; c++) {
      candidates.push(__eb_describe(__eb_inputs[c], c));
    }
    return {
      found: false,
      reason: targeted
        ? ("no TextInput matched that target (" + __eb_inputs.length + " input(s) mounted)")
        : ${JSON.stringify(NO_FOCUS_REASON)},
      candidates: candidates,
      totalInputs: __eb_inputs.length
    };
  }

  var __eb_index = ${typeof query?.index === "number" ? String(query.index) : "null"};
  if (__eb_index !== null) {
    if (__eb_index < 0 || __eb_index >= __eb_matches.length) {
      return {
        found: false,
        reason: "index " + __eb_index + " is out of range — " + __eb_matches.length + " input(s) matched",
        candidates: __eb_matches.map(__eb_describe),
        totalInputs: __eb_inputs.length
      };
    }
  } else if (__eb_matches.length > 1) {
    return {
      found: false,
      ambiguous: true,
      reason: __eb_matches.length + " inputs match this target — pass index to choose one, or target more precisely",
      candidates: __eb_matches.map(__eb_describe),
      totalInputs: __eb_inputs.length
    };
  }

  var __eb_host = __eb_matches[__eb_index === null ? 0 : __eb_index];

  var __eb_ownerFiber = __eb_owner(__eb_host);
  var __eb_pubi = __eb_pub(__eb_host);
  // Controlled means the value prop MIRRORS the field's text — the only way to
  // read a field back from JS. RN does not reflect native text into fiber props
  // for uncontrolled inputs (verified on device: the host's text prop stays
  // undefined after typing, though mostRecentEventCount increments; an
  // uncontrolled field
  // cannot be verified this way no matter which write path put the text there.
  var __eb_controlled = !!(__eb_ownerFiber &&
    typeof __eb_ownerFiber.memoizedProps.value === "string");
  var __eb_value = __eb_controlled
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
    testID: __eb_testIDOf(__eb_host),
    controlled: __eb_controlled,
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
            // Only a controlled field can be cleared through its handler. On an
            // uncontrolled one that handler may be a no-op (or may not drive the
            // text at all), so calling it clears nothing while reporting success.
            action = `
  if (__eb_controlled) {
    __eb_ownerFiber.memoizedProps.onChangeText("");
    return { ${BASE}, value: "", ok: true, via: "onChangeText" };
  }
  if (__eb_pubi && typeof __eb_pubi.clear === "function") {
    __eb_pubi.clear();
    return { ${BASE}, value: null, ok: true, via: "publicInstance.clear" };
  }
  return { ${BASE}, ok: false, via: "input exposes no clear() method" };`;
            break;
    }

    return `(() => {${prelude(query)}${action}
})()`;
}
