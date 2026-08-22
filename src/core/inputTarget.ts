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
    /**
     * The already-resolved field, pinned by native tag.
     *
     * Set by callers AFTER a resolve so every later operation addresses the
     * same field. A query is a description, and a write changes the thing being
     * described: `textMatch` matching a field's VALUE stops matching the moment
     * the value is replaced, so the read-back and retry then re-resolved to
     * nothing and a landed write was reported as "no TextInput matched that
     * target". Falls back to the rest of the query when the tag is gone, which
     * is what a genuine remount looks like.
     */
    nativeTag?: number;
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
    /** Writes native text directly, for a field with no handler to drive. */
    | { kind: "setNative"; value: string }
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
    /**
     * Every input on screen, not just the resolved one. Returned by `find`
     * alone — it is the baseline screenStaleness compares the NEXT miss
     * against, and a miss can only be judged a race if we know what the screen
     * looked like when it was last working. Capped like the candidate lists.
     */
    allInputs?: InputCandidate[];
};

export type InputMissing = {
    found: false;
    reason: string;
    /** True when the target matched several inputs and none was chosen. */
    ambiguous?: boolean;
    /**
     * True when `candidates` holds the inputs that MATCHED, not the inputs on
     * screen. Without it the renderer compares the list against `totalInputs`
     * and prints "showing 1 of 4" — which says the list was truncated when in
     * fact 1 of the 4 mounted inputs matched and all of them are listed. Agents
     * read that as "there are more, try a higher index" and pass one, which is
     * where the `index 1 is out of range` events on 2.8.1 come from.
     */
    matchedOnly?: boolean;
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
  var wantTag = ${query?.nativeTag != null ? String(query.nativeTag) : "null"};

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

  // Is the component target the name of a PRIMITIVE rather than of anything the app authored? Used far below, and only to decide what a ZERO-match component filter means.
  //
  // Verified live on device 2026-08-22, six mounted inputs: component: "TextInput" matched all six, because the match is a case-insensitive SUBSTRING over the collected authored names and wrappers called InternalTextInput / StyledTextInput contain it. RN's own TextInput fiber never reaches that list (RN_PRIMITIVES filters it, and it is a forwardRef whose name __eb_name cannot read), so on an app whose wrappers are named otherwise the same target matches nothing at all — that is the production shape (VisitSearchBarV2, SheetPriceCardV2, StepperV2). App-dependent, not universal, so the filter itself stays exactly as it is.
  //
  // The two injected filters list neither TextInput nor AndroidTextInput (verified 2026-08-22 — RCT* is covered by RN_PRIMITIVES, those two by nothing), so the host list this file already declares carries the rest.
  //
  // Only when the caller ALSO gave no testID and no textMatch: those run their own branch, and a fall-through there would resolve a field they never described.
  var __eb_primitiveComponent = wantTestID === null && wantText === null && wantComponent !== null &&
    (RN_PRIMITIVES.test(wantComponent) || GENERIC_COMPONENT.test(wantComponent) ||
     HOSTS.indexOf(wantComponent) !== -1 || String(wantComponent).toLowerCase() === "textinput");

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

  // A field's descriptive props. An input with NO onChangeText has no owner
  // composite at all, so reading placeholder/value from the owner alone makes
  // handler-less fields invisible to textMatch and blank in candidate lists.
  function __eb_props(hostFiber) {
    var o = __eb_owner(hostFiber);
    return (o && o.memoizedProps) || hostFiber.memoizedProps || {};
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

  // EVERY authored name on the path from the host up to the field wrapper.
  //
  // Display resolves a field to one name (the wrapper), but get_screen_state
  // names the same field by its INNERMOST composite — so a caller reading the
  // screen can legitimately hold either name. Matching against the display name
  // alone made one of the two names printed on screen fail to resolve, and the
  // resulting "no TextInput matched that target" is indistinguishable from the
  // field genuinely not being there.
  //
  // Bounded the same way the display climb is: at the wrapper when there is
  // one, else the 4-composite budget — never further, or a target would match
  // on the name of the screen the field happens to sit in.
  function __eb_componentNames(hostFiber) {
    var names = [];
    var stop = __eb_fieldFiber(hostFiber);
    var p = hostFiber;
    var d = 0;
    var composites = 0;
    while (p && d < 30) {
      if (typeof p.type !== "string" && p.type !== null) {
        var n = __eb_name(p.type);
        if (n) {
          composites++;
          if (!RN_PRIMITIVES.test(n) && !GENERIC_COMPONENT.test(n) && names.indexOf(n) === -1) {
            names.push(n);
          }
        }
      }
      if (stop) { if (p === stop) break; }
      else if (composites >= 4) break;
      p = p.return;
      d++;
    }
    return names;
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
    var op = __eb_props(hostFiber);
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

  // The pin, tried FIRST: the native tag of a field already resolved by an earlier op in the same call.
  //
  // A query is a description and a write changes the thing being described, so every predicate below is destroyed by the very write it was used to aim. The tag is not — it survives the value being replaced, which is the whole reason it exists. Telemetry 2026-08-22: 83 of the 145 bad_target failures in 7 days are a textMatch aimed at a value the same call had just overwritten.
  //
  // Verified live 2026-08-22 on RN 0.85 with newArchEnabled: __eb_pub resolves to a ReactNativeElement carrying a real __nativeTag, so this works on Fabric as well as on the legacy architecture. A host that yields no tag matches nothing here and falls straight through, which is also what a genuine remount does — the fall-through IS the safety net, and no other fallback is wanted.
  if (wantTag !== null) {
    for (i = 0; i < __eb_inputs.length; i++) {
      var tp = __eb_pub(__eb_inputs[i]);
      if (tp && tp.__nativeTag === wantTag) __eb_matches.push(__eb_inputs[i]);
    }
  }
  var __eb_pinned = __eb_matches.length > 0;

  if (!__eb_pinned) {
    if (wantTestID !== null) {
      for (i = 0; i < __eb_inputs.length; i++) {
        if (__eb_testIDOf(__eb_inputs[i]) === wantTestID) __eb_matches.push(__eb_inputs[i]);
      }
    } else if (wantComponent !== null) {
      var wc = String(wantComponent).toLowerCase();
      for (i = 0; i < __eb_inputs.length; i++) {
        var cns = __eb_componentNames(__eb_inputs[i]);
        var hit = false;
        for (var ci = 0; ci < cns.length; ci++) {
          if (cns[ci].toLowerCase().indexOf(wc) !== -1) { hit = true; break; }
        }
        if (hit) __eb_matches.push(__eb_inputs[i]);
      }
    } else if (wantText !== null) {
      var wt = String(wantText).toLowerCase();
      for (i = 0; i < __eb_inputs.length; i++) {
        var mp3 = __eb_props(__eb_inputs[i]);
        var hay = String(
          (mp3.value || "") + " " + (mp3.placeholder || "") + " " +
          (mp3.accessibilityLabel || "") + " " + (__eb_labelOf(__eb_inputs[i]) || "")
        ).toLowerCase();
        if (hay.indexOf(wt) !== -1) __eb_matches.push(__eb_inputs[i]);
      }
    }
  }

  // Untargeted — or a component filter that named a primitive and matched NOTHING.
  //
  // The second case is C1. A component: "TextInput" target selects every input on an app whose wrappers happen to contain that substring, and that 6-way "pass index to choose one" answer is correct and useful, so it is left alone. On an app whose wrappers do not, the same target selected zero and the caller was told "no TextInput matched that target (6 input(s) mounted)" — which reads as the field being absent when six of them are right there. Telemetry 2026-08-22: 145 bad_target failures in 7 days, 32 targeted by component, 12 of those on that one literal string.
  //
  // A primitive name describes nothing the app authored, so it cannot be evidence that the field is missing. Falling through resolves it the way an untargeted call would, and still refuses to guess when there is a real choice to get wrong.
  if (__eb_matches.length === 0 && (__eb_primitiveComponent || (wantTestID === null && wantComponent === null && wantText === null))) {
    for (i = 0; i < __eb_inputs.length; i++) {
      var pf = __eb_pub(__eb_inputs[i]);
      if (pf && pf.isFocused && pf.isFocused()) __eb_matches.push(__eb_inputs[i]);
    }
    // Nothing focused, but only ONE input is mounted: resolve to it instead of
    // demanding a tap or a testID. The refusal to guess exists to stop text
    // landing in the WRONG field, and a wrong field needs a second candidate to
    // exist. Telemetry 2026-08-10: a search sheet with a single field failed
    // this way while there was nothing else the caller could have meant.
    if (__eb_matches.length === 0 && __eb_inputs.length === 1) __eb_matches.push(__eb_inputs[0]);
  }

  // A primitive component target that matched nothing was never a description of a field, so the miss it produces is the no-focus miss, not a "your target is wrong" miss.
  var targeted = (wantTestID !== null || wantComponent !== null || wantText !== null) && !__eb_primitiveComponent;

  if (__eb_matches.length === 0) {
    var candidates = [];
    for (var c = 0; c < __eb_inputs.length && candidates.length < 12; c++) {
      candidates.push(__eb_describe(__eb_inputs[c], c));
    }
    var reason = targeted
      ? ("no TextInput matched that target (" + __eb_inputs.length + " input(s) mounted)")
      : ${JSON.stringify(NO_FOCUS_REASON)};

    // C3, and error-message quality ONLY: no matcher is loosened, nothing is guessed, the miss is still a miss. Verified live 2026-08-22 — testID "name-inpu" against a mounted "name-input" returned the bare "no TextInput matched that target" plus the candidate list, and the list pushes everything useful past the 200-char truncation telemetry applies to the message, so the closest match goes at the FRONT of the string.
    //
    // Telemetry 2026-08-22: 26 of the 145 bad_target failures in 7 days are strict-equality testID misses (login.username.input, search-input, church-search-list-search-input) — names that plainly belong to the screen the caller was looking at, off by a prefix. Containment either way catches those for one lowercase compare per mounted input, which is what this can afford: it runs inside the user's app on every failed call.
    if (wantTestID !== null) {
      var wid = String(wantTestID).toLowerCase();
      for (var h = 0; h < candidates.length; h++) {
        var cid = candidates[h].testID ? String(candidates[h].testID).toLowerCase() : "";
        if (cid && (cid.indexOf(wid) !== -1 || wid.indexOf(cid) !== -1)) {
          reason = 'did you mean testID "' + candidates[h].testID + '" (index ' + candidates[h].index + ')? no mounted input has testID "' + wantTestID + '" (' + __eb_inputs.length + " input(s) mounted)";
          break;
        }
      }
    }
    return {
      found: false,
      reason: reason,
      candidates: candidates,
      totalInputs: __eb_inputs.length
    };
  }

  var __eb_index = ${typeof query?.index === "number" ? String(query.index) : "null"};
  // A pinned tag already names ONE field, so an index carried over from the original query does not apply to it — the index chose among the PREDICATE's matches, and there is only ever one match for a tag. Left in, "index 2" against a single pinned match reports "index 2 is out of range — 1 input(s) matched": a failure invented by the pin, on a call that had just resolved correctly. The index keeps its meaning on the fall-through, where the predicate is doing the matching again.
  if (__eb_pinned) __eb_index = null;
  var __eb_pick = __eb_index === null ? 0 : __eb_index;
  if (__eb_index !== null) {
    if (__eb_index < 0 || __eb_index >= __eb_matches.length) {
      return {
        found: false,
        reason: "index " + __eb_index + " is out of range — " + __eb_matches.length + " input(s) matched",
        matchedOnly: true,
        candidates: __eb_matches.map(__eb_describe),
        totalInputs: __eb_inputs.length
      };
    }
  } else if (__eb_matches.length > 1) {
    // Candidates that describe IDENTICALLY are not a choice. A screen kept
    // mounted underneath its own re-push (React Navigation does this) presents
    // the same testID, placeholder, label and value twice, and "pass index to
    // choose one" then asks the caller to pick between two lines of the same
    // text — a coin flip it cannot inform. The later fiber is the visible one:
    // the walk is DFS in mount order, so the screen pushed last is walked last.
    // Only a genuinely distinguishable set still refuses.
    var __eb_shape = [];
    for (i = 0; i < __eb_matches.length; i++) __eb_shape.push(JSON.stringify(__eb_describe(__eb_matches[i], 0)));
    var __eb_identical = true;
    for (i = 1; i < __eb_shape.length; i++) {
      if (__eb_shape[i] !== __eb_shape[0]) { __eb_identical = false; break; }
    }
    if (!__eb_identical) {
      return {
        found: false,
        ambiguous: true,
        reason: __eb_matches.length + " inputs match this target — pass index to choose one, or target more precisely",
        candidates: __eb_matches.map(__eb_describe),
        totalInputs: __eb_inputs.length
      };
    }
    __eb_pick = __eb_matches.length - 1;
  }

  var __eb_host = __eb_matches[__eb_pick];

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
            // The only op that reports the whole screen. Every later op
            // addresses one already-resolved field, so paying for the full list
            // there would be five serialisations of the same thing per write.
            action = `
  var __eb_all = [];
  for (var ai = 0; ai < __eb_inputs.length && __eb_all.length < 12; ai++) {
    __eb_all.push(__eb_describe(__eb_inputs[ai], ai));
  }
  return { ${BASE}, ok: true, allInputs: __eb_all };`;
            break;

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

        case "setNative":
            // Sets the native text, then fires onChangeText if the field has
            // one. Both halves matter: without the first the field shows
            // nothing, without the second the app never receives the text —
            // and a field that displays text the app does not have is the
            // "looks right, isn't" failure this tool exists to remove.
            action = `
  var nv = ${JSON.stringify((op as { kind: "setNative"; value: string }).value)};
  if (!__eb_pubi || typeof __eb_pubi.setNativeProps !== "function") {
    return { ${BASE}, ok: false, via: "input exposes no setNativeProps" };
  }
  __eb_pubi.setNativeProps({ text: nv });
  if (__eb_ownerFiber) {
    __eb_ownerFiber.memoizedProps.onChangeText(nv);
    return { ${BASE}, value: __eb_controlled ? nv : __eb_value, ok: true, via: "setNativeProps+onChangeText" };
  }
  return { ${BASE}, ok: true, via: "setNativeProps" };`;
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
