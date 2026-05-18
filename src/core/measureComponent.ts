export type MeasureOutcome =
    | "measured"
    | "no_match"
    | "no_host_descendant"
    | "timeout"
    | "error";

export interface MeasureBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    nativeTag?: number;
}

export type MeasureToolResult =
    | ({ success: true; outcome: "measured" } & MeasureBounds)
    | { success: false; outcome: Exclude<MeasureOutcome, "measured">; error: string };

export function buildMeasureComponentExpression(componentName: string, index: number): string {
    const escapedName = componentName.replace(/'/g, "\\'");
    const safeIndex = typeof index === "number" && Number.isFinite(index) ? index : 0;
    return `new Promise((resolve) => {
  try {
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) { resolve({ outcome: "error", error: "React DevTools hook not found." }); return; }
    let root = null;
    const ids = Array.from(hook.renderers ? hook.renderers.keys() : []);
    for (const id of ids) {
      const roots = hook.getFiberRoots ? Array.from(hook.getFiberRoots(id) || []) : [];
      if (roots.length > 0) { root = roots[0]; break; }
    }
    if (!root) { resolve({ outcome: "error", error: "No fiber roots found." }); return; }

    const targetName = '${escapedName}';
    const targetIndex = ${safeIndex};

    const getName = (t) => typeof t === "string" ? t : (t && (t.displayName || t.name)) || null;

    // Collect all matching fibers (depth-first, parent before children).
    const matches = [];
    (function walk(f) {
      if (!f) return;
      if (getName(f.type) === targetName) matches.push(f);
      if (f.child) walk(f.child);
      if (f.sibling) walk(f.sibling);
    })(root.current);

    if (matches.length === 0 || targetIndex < 0 || targetIndex >= matches.length) {
      resolve({ outcome: "no_match", error: "no component matched '" + targetName + "'" });
      return;
    }
    const matched = matches[targetIndex];
    const matchedName = getName(matched.type);

    // Resolve a measurable host instance: matched fiber or nearest host descendant.
    const getMeasurable = (f) => {
      if (!f || !f.stateNode) return null;
      const sn = f.stateNode;
      if (typeof sn.measureInWindow === "function") {
        return { instance: sn, nativeTag: sn._nativeTag };
      }
      if (sn.canonical && sn.canonical.publicInstance && typeof sn.canonical.publicInstance.measureInWindow === "function") {
        const pub = sn.canonical.publicInstance;
        return { instance: pub, nativeTag: pub.__nativeTag };
      }
      return null;
    };

    let target = getMeasurable(matched);
    if (!target) {
      // Descend to nearest host descendant with measureInWindow.
      (function findHost(f) {
        if (!f || target) return;
        if (f !== matched) {
          const m = getMeasurable(f);
          if (m) { target = m; return; }
        }
        if (f.child) findHost(f.child);
        if (f.sibling && f !== matched) findHost(f.sibling);
      })(matched.child);
    }

    if (!target) {
      resolve({ outcome: "no_host_descendant", error: "component '" + targetName + "' has no measurable stateNode at index " + targetIndex });
      return;
    }

    let done = false;
    target.instance.measureInWindow((x, y, width, height) => {
      if (done) return;
      done = true;
      resolve({
        outcome: "measured",
        x: x,
        y: y,
        width: width,
        height: height,
        name: matchedName,
        nativeTag: typeof target.nativeTag === "number" ? target.nativeTag : undefined,
      });
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ outcome: "timeout", error: "measureInWindow timed out (1500ms)" });
    }, 1500);
  } catch (e) {
    resolve({ outcome: "error", error: (e && e.message) || String(e) });
  }
})`;
}
