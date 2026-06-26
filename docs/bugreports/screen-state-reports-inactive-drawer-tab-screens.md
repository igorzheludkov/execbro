# Bug: screen-state / pressable scans report mounted-but-hidden Drawer & Tab screens

## Summary

`ios_screenshot` / `android_screenshot` (screen-state block), `get_pressable_elements`,
`get_screen_layout`, and `find_components` report interactive elements that belong to
**inactive Drawer and Bottom-Tab screens** which are mounted but not visible.

The fiber walk already prunes hidden **native-stack** screens, but the guards it uses do
not match how `@react-navigation/drawer` and `@react-navigation/bottom-tabs` keep their
inactive routes mounted. As a result, when the focused screen is e.g. a Drawer
destination, the output also lists pressables from every other Drawer destination and from
every Bottom-Tab stack.

## Severity

Medium. No crash, but the tool output is misleading: agents see (and may try to `tap`)
elements that are not on screen, and the element list is bloated with off-screen items.

## Environment

- App: `execbro-test-app` (the playground), React Native 0.85, React 19.2, New Arch / Hermes.
- Navigation: root `Drawer` → `Bottom-Tabs` → per-tab native stacks, plus Drawer
  destinations (Storage stack, Native, Settings, Modals stack).
- `react-native-screens` present (default `detachInactiveScreens` / freeze behavior).

## Reproduction

1. Launch the playground and `scan_metro`.
2. Open the Drawer and navigate to **Storage → MMKV** (a Drawer destination).
3. Call `ios_screenshot` (or `get_pressable_elements`).

### Actual

`Currently focused screen: "Storage"`, but the pressable list also contains items from
other, non-visible screens, e.g.:

```
📍 Currently focused screen: "Storage"  [navigation stack: Storage]
  <HeaderMenuButton /> "Open navigation drawer"
  <Button /> "Request camera permission"   testID="native-permission"   ← Native screen
  <ScrollView /> "Tap Targets"             testID="screen-nav-TapTargets" ← UI tab
  <Button /> "Show alert"                  testID="native-alert"          ← Native screen
  <Button /> "Save"                        testID="mmkv-save"             ← (correct) MMKV
  <ScrollView /> "Submit"                  testID="submit-btn"            ← UI tab
  <ScrollView /> "Go to Scroll"            testID="nav-scroll-btn"        ← UI tab
  ...
```

The MMKV screen renders cleanly on device — this is **not** a visual/z-index overlap. The
extra items are mounted-but-hidden sibling screens leaking into the fiber scan.

### Expected

Only elements belonging to the currently-focused route subtree (here: the MMKV screen,
its sibling-nav strip, and the header) should be reported. Inactive Drawer destinations and
inactive Tab stacks should be excluded, exactly as inactive native-stack screens already are.

## Root cause

The injected fiber walks short-circuit on a small set of native-stack-specific "hidden
screen" signals, but Drawer/Tab inactive routes don't carry those exact prop shapes, so the
walk descends into them.

Existing guards (duplicated across the walk entry points):

- `src/core/pressables.ts:347-349` (pressable walk) and `:415-417` (input walk)
- `src/core/screenLayout.ts:458-460`
- `src/core/screenState.ts:826-831` (`isScreenHidden`) — overlay walk

```js
if (name === 'MaybeScreen' && props && props.active === 0) return;        // react-native-screens
if (name === 'SceneView'   && props && props.focused === false) return;   // NativeStackNavigator
if (name === 'RNSScreen'   && props && props['aria-hidden'] === true) return;
```

### Confirmed evidence (live fiber inspection on the playground at Storage → MMKV)

Walking the fiber tree for `Screen` / `RNSScreen` / `MaybeScreen` nodes and reading the
relevant props returns (trimmed):

```
{ n: 'MaybeScreen', enabled: true }                       // no activityState here
{ n: 'Screen',      activityState: 0, enabled: true }     // inactive route  ← should be pruned
{ n: 'RNSScreen',   activityState: 0 }                    // inactive route  ← should be pruned
{ n: 'Screen',      activityState: 2, enabled: true }     // FOCUSED route   ← keep
{ n: 'RNSScreen',   activityState: 2 }                    // FOCUSED route   ← keep
{ n: 'Screen',      activityState: 0 } ...                // more inactive routes
```

`react-native-screens` activity states: **`0` = inactive, `1` = transitioning, `2` = active**.

This makes the bug exact:

1. **Wrong prop name.** Inactive screens are flagged with **`activityState`**, not `active`.
2. **Wrong node.** `activityState` lives on **`Screen` / `RNSScreen`**, while the existing
   guard checks it on **`MaybeScreen`** (which only carries `enabled`). So the guard
   `name === 'MaybeScreen' && props.active === 0` can never match — inactive Drawer/Tab (and
   even inactive native-stack) routes are never pruned by it.
3. **`detachInactiveScreens` only detaches natively.** Even when react-native-screens
   detaches an inactive screen, the JS fiber subtree stays mounted, so the walk (which reads
   the JS fiber tree) still sees it unless it honors `activityState`.

So the bug is a coverage gap in the "is this fiber inside a hidden navigation scene?" check:
it should prune on `Screen`/`RNSScreen` with `activityState === 0`.

## Proposed fix

Centralize and broaden the hidden-scene guard, then apply it at every walk entry point.

### 1. Add one shared predicate (injected-JS source)

Define once (e.g. near the other walk helpers shared by `pressables.ts` / `screenState.ts`
/ `screenLayout.ts`) and reuse:

```js
function isHiddenNavigationScene(name, props) {
  if (!props) return false;
  // PRIMARY (confirmed): react-native-screens inactive route.
  // activityState lives on Screen / RNSScreen; 0 = inactive, 2 = active.
  if (name === 'Screen' || name === 'RNSScreen' || name === 'MaybeScreen') {
    if (props.activityState === 0) return true;
    if (props.active === 0) return true; // legacy / defensive
  }
  // NativeStackNavigator scene
  if (name === 'SceneView' && props.focused === false) return true;
  // Defensive extras (other react-navigation versions / platforms)
  if (props['aria-hidden'] === true) return true;
  if (props.accessibilityElementsHidden === true) return true;
  if (props.importantForAccessibility === 'no-hide-descendants') return true;
  var style = props.style;
  if (style && !Array.isArray(style) && style.display === 'none') return true;
  if (Array.isArray(style) && style.some(function (s) { return s && s.display === 'none'; })) return true;
  return false;
}
```

The **confirmed minimal fix** is the `activityState === 0` check on `Screen`/`RNSScreen`;
the rest are defensive. Replace the three-line guards at the four locations above with
`if (isHiddenNavigationScene(name, props)) return;`. Note that the inactive `activityState`
sits on the `Screen`/`RNSScreen` wrapper, which is an **ancestor** of the route content —
so the guard must run during descent (return/skip the subtree) at that node, which the
current walk already does at the equivalent native-stack guards.

### 2. (Stronger, optional) Prune by focused navigation route

`screenState.ts` already resolves the focused route + stack
(`getCurrentRoute` / `NavigationContainer` `getRootState`, `collectFiberStack`, see
`src/core/screenState.ts:447-581`). The walk could additionally use this to keep only the
focused route's subtree at each navigator boundary. The predicate in (1) is the lower-risk,
self-contained fix; (2) is a more robust follow-up if prop heuristics prove brittle across
react-navigation versions.

## Verification snippet

This `execute_in_app` snippet was used to confirm the root cause above (it lists each
`Screen`/`RNSScreen`/`MaybeScreen` with its activity/visibility props); reuse it to verify
the fix and to check other apps/versions:

```js
(function(){
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__; if(!hook) return 'no hook';
  var roots = Array.from(hook.getFiberRoots ? hook.getFiberRoots(1) : []);
  var out = [];
  function name(f){ var t=f.type; if(typeof t==='string') return t; if(t&&(t.displayName||t.name)) return t.displayName||t.name; return null; }
  function walk(f, d){ if(!f||d>120) return; var n=name(f);
    if(n && /RNSScreen|^Screen$|MaybeScreen/.test(n)){ var p=f.memoizedProps||{}, s=p.style&&!Array.isArray(p.style)?p.style:null;
      out.push({ n:n, activityState:p.activityState, active:p.active, a11yHidden:p.accessibilityElementsHidden, important:p.importantForAccessibility, display:s&&s.display }); }
    walk(f.child,d+1); walk(f.sibling,d+1); }
  roots.forEach(function(r){ walk(r.current,0); });
  return out.slice(0,20);
})()
```

Confirmed result: inactive routes report `activityState: 0`, the focused route reports
`activityState: 2`, and `MaybeScreen` carries no `activityState` (only `enabled`).

## Affected tools / files

- `get_pressable_elements` → `src/core/pressables.ts` (walks at `:341`, `:411`, `:453`)
- `ios_screenshot` / `android_screenshot` screen-state → `src/core/screenState.ts`
  (pressable extraction `:689-933`, `isScreenHidden` `:826`)
- `get_screen_layout` → `src/core/screenLayout.ts:458`
- `find_components` / `get_component_tree` → `src/core/componentSearch.ts`,
  `src/core/componentTree.ts` (note: `get_component_tree` has `focusedOnly` /
  `findFocusedScreen`, which already mitigates this for that tool; the others do not).

## Acceptance criteria

- On the playground at **Storage → MMKV**, `get_pressable_elements` / `ios_screenshot`
  return only MMKV-screen pressables (+ the sibling-nav strip + header burger), with no
  `native-*`, `redux-*`, `submit-btn`, `nav-scroll-btn`, etc. from inactive routes.
- Switching Bottom-Tabs (e.g. to **State → Redux**) shows only that tab's pressables, not
  the other three tabs' stacks.
- Native-stack hidden-screen filtering continues to work (no regression).
- Overlays/modals still report their pressables (overlay walk unaffected).

## Resolution

Resolved 2026-06-27 on branch `fix/screen-visibility-engine`.

**Headline correction to the root cause.** The proposed `activityState === 0` fix is
*insufficient*. Live fiber inspection showed a non-focused Drawer destination that the drawer
keeps warm reports **`activityState: 2`** (active) all the way down — so an activityState-only
guard never prunes it. The signal that reliably excludes it is the React Navigation **focus
rule**: an unfocused scene wrapper `Screen` with `focused === false` and a `route` prop.
Early-returning at it during descent also AND-chains focus for free (inner focused nodes of a
pruned ancestor are never reached).

**Implementation.** A single shared injected-JS predicate
`isHiddenNavigationScene(name, props)` in `src/core/injected/visibility.ts` (focus rule +
broadened `activityState === 0` + generic hidden-view guards), unit-tested with a parity test
proving the `.toString()`-injected source matches the TS function. Applied at every walk entry
point:

- `src/core/screenState.ts` (delegated `isScreenHidden`)
- `src/core/pressables.ts` (replaced the four inline guards + local `isScreenHidden`)
- `src/core/screenLayout.ts` (both guard sites)
- `src/core/componentTree.ts` (`findFocusedScreen` skip) and `src/core/componentSearch.ts`
  (new opt-in `visibleOnly` arg on `find_components`)

**Bonus — native-presented sheets.** `get_screen_state` now detects open native sheets
(e.g. True Sheet via its `TrueSheetContainerView`/`TrueSheetContentView` markers), sets a
`nativeOverlay` flag + `notes`, marks the underlying pressables blocked, and steers the agent
to screenshot/OCR (the sheet's content is presented outside the RN coordinate space, so its
`measureInWindow` data is unreliable).

**Verified on-device matrix** (iPhone Air, playground): drawer destinations isolated
(Native / Modals each clean), bottom-tab switch (UI/Debug → State) swaps cleanly, RN `<Modal>`
+ gorhom (50%/full) overlays still group + block, True Sheet (50%/full) flags `nativeOverlay`.

**Deferred (Layer D, follow-up).** Pure-native surfaces — system **share sheet**, **alert**,
image picker — are absent from the fiber tree, so these tools still list the underlying screen
as reachable while such a surface is up. Detecting them needs the OCR/accessibility
ground-truth layer (opt-in), tracked in the spec's deferred section.

Spec: `~/rn-devtools/docs/devtools-core/specs/2026-06-26-screen-visibility-engine-design.md`.
Plan: `~/rn-devtools/docs/devtools-core/plans/2026-06-26-screen-visibility-engine.md`.
