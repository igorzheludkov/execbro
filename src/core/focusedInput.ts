export type FindFocusedInputResult =
    | { focused: false; reason: string }
    | {
          focused: true;
          nativeTag: number;
          value: string | null;
          hasOnChangeText: boolean;
      };

export type ClearFocusedInputResult =
    | { cleared: false; reason: string }
    | { cleared: true; via: "onChangeText" | "publicInstance" };

export type DismissKeyboardResult =
    | { dismissed: false; reason: string }
    | { dismissed: true; nativeTag: number };

export function buildFindFocusedInputExpression(): string {
    return `(() => {
  const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { focused: false, reason: "no devtools hook" };
  const ids = Array.from(hook.renderers.keys());
  let root = null;
  for (const id of ids) {
    const roots = Array.from(hook.getFiberRoots(id));
    if (roots.length > 0) { root = roots[0]; break; }
  }
  if (!root) return { focused: false, reason: "no fiber root" };
  const getName = (t) => typeof t === "string" ? t : (t && (t.displayName || t.name)) || null;
  let host = null;
  (function walk(f, depth) {
    if (!f || host || depth > 400) return;
    const name = getName(f.type);
    if (name === "RCTSinglelineTextInputView" || name === "RCTMultilineTextInputView") {
      const pub = f.stateNode && f.stateNode.canonical && f.stateNode.canonical.publicInstance;
      if (pub && pub.isFocused && pub.isFocused()) { host = f; return; }
    }
    if (f.child) walk(f.child, depth + 1);
    if (f.sibling) walk(f.sibling, depth);
  })(root.current, 0);
  if (!host) return { focused: false, reason: "no focused TextInput" };
  let inputFiber = null;
  for (let p = host; p; p = p.return) {
    if (p.memoizedProps && typeof p.memoizedProps.onChangeText === "function") { inputFiber = p; break; }
  }
  const pub = host.stateNode.canonical.publicInstance;
  return {
    focused: true,
    nativeTag: pub.__nativeTag,
    value: inputFiber ? (inputFiber.memoizedProps.value == null ? null : String(inputFiber.memoizedProps.value)) : null,
    hasOnChangeText: !!inputFiber,
  };
})()`;
}

export function buildClearFocusedInputExpression(): string {
    return `(() => {
  const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { cleared: false, reason: "no devtools hook" };
  const ids = Array.from(hook.renderers.keys());
  let root = null;
  for (const id of ids) {
    const roots = Array.from(hook.getFiberRoots(id));
    if (roots.length > 0) { root = roots[0]; break; }
  }
  if (!root) return { cleared: false, reason: "no fiber root" };
  const getName = (t) => typeof t === "string" ? t : (t && (t.displayName || t.name)) || null;
  let host = null;
  (function walk(f, depth) {
    if (!f || host || depth > 400) return;
    const name = getName(f.type);
    if (name === "RCTSinglelineTextInputView" || name === "RCTMultilineTextInputView") {
      const pub = f.stateNode && f.stateNode.canonical && f.stateNode.canonical.publicInstance;
      if (pub && pub.isFocused && pub.isFocused()) { host = f; return; }
    }
    if (f.child) walk(f.child, depth + 1);
    if (f.sibling) walk(f.sibling, depth);
  })(root.current, 0);
  if (!host) return { cleared: false, reason: "no focused TextInput" };
  let inputFiber = null;
  for (let p = host; p; p = p.return) {
    if (p.memoizedProps && typeof p.memoizedProps.onChangeText === "function") { inputFiber = p; break; }
  }
  if (inputFiber) {
    inputFiber.memoizedProps.onChangeText("");
    return { cleared: true, via: "onChangeText" };
  }
  const pub = host.stateNode.canonical.publicInstance;
  if (pub && typeof pub.clear === "function") {
    pub.clear();
    return { cleared: true, via: "publicInstance" };
  }
  return { cleared: false, reason: "no clear method available" };
})()`;
}

export function buildDismissKeyboardExpression(): string {
    return `(() => {
  const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { dismissed: false, reason: "no devtools hook" };
  const ids = Array.from(hook.renderers.keys());
  let root = null;
  for (const id of ids) {
    const roots = Array.from(hook.getFiberRoots(id));
    if (roots.length > 0) { root = roots[0]; break; }
  }
  if (!root) return { dismissed: false, reason: "no fiber root" };
  const getName = (t) => typeof t === "string" ? t : (t && (t.displayName || t.name)) || null;
  let host = null;
  (function walk(f, depth) {
    if (!f || host || depth > 400) return;
    const name = getName(f.type);
    if (name === "RCTSinglelineTextInputView" || name === "RCTMultilineTextInputView") {
      const pub = f.stateNode && f.stateNode.canonical && f.stateNode.canonical.publicInstance;
      if (pub && pub.isFocused && pub.isFocused()) { host = f; return; }
    }
    if (f.child) walk(f.child, depth + 1);
    if (f.sibling) walk(f.sibling, depth);
  })(root.current, 0);
  if (!host) return { dismissed: false, reason: "no focused TextInput" };
  const pub = host.stateNode.canonical.publicInstance;
  if (pub && typeof pub.blur === "function") {
    pub.blur();
    return { dismissed: true, nativeTag: pub.__nativeTag };
  }
  return { dismissed: false, reason: "no blur method available" };
})()`;
}
