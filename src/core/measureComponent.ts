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
      // Fabric shadow-node handle: no public instance on the fiber, but the UIManager can
      // measure the node directly. Without this branch a plain RCTView is invisible to the
      // search, so it walked past every one of them and picked whatever deep descendant
      // happened to expose a public instance — on RN 0.83 that was an RNGestureHandlerButton
      // inside the first tab, which made measure("ShopHeader") and measure("SubTabBar")
      // return byte-identical frames and the same nativeTag. Same branch screenState and
      // componentSource already carry; measure was the one that never got it.
      const node = sn.node || (sn.canonical && sn.canonical.node);
      if (node && globalThis.nativeFabricUIManager && typeof globalThis.nativeFabricUIManager.measureInWindow === "function") {
        // The tag lives on the canonical record here, not on a public instance.
        const canonicalTag = sn.canonical && typeof sn.canonical.nativeTag === "number"
          ? sn.canonical.nativeTag
          : undefined;
        return {
          instance: {
            measureInWindow: (cb) => {
              try { globalThis.nativeFabricUIManager.measureInWindow(node, cb); } catch (e) {}
            }
          },
          nativeTag: canonicalTag
        };
      }
      return null;
    };

    let target = getMeasurable(matched);
    if (!target) {
      // Breadth-first, so the SHALLOWEST measurable host wins.
      //
      // The previous descent was pre-order depth-first, which follows one spine to the leaf
      // before trying the next branch. With a getMeasurable that can miss, that turns a near
      // miss into a wildly wrong answer: the component's own container is skipped and some
      // small leaf several levels down is measured and reported under the component's name.
      // Breadth-first cannot do that — it exhausts a whole depth before descending.
      const enqueueChain = (start, q) => { let n = start; while (n) { q.push(n); n = n.sibling; } };
      const queue = [];
      enqueueChain(matched.child, queue);
      let guard = 0;
      while (queue.length > 0 && !target && guard++ < 20000) {
        const f = queue.shift();
        const m = getMeasurable(f);
        if (m) { target = m; break; }
        enqueueChain(f.child, queue);
      }
    }

    if (!target) {
      resolve({ outcome: "no_host_descendant", error: "component '" + targetName + "' has no measurable stateNode at index " + targetIndex });
      return;
    }

    let done = false;
    // Held so the loser can be cancelled. Without this the 1.5s timer stays armed in the
    // app's runtime after every successful measure — harmless, but it is a timer per call
    // that exists only to be ignored.
    let timeoutId = null;
    target.instance.measureInWindow((x, y, width, height) => {
      if (done) return;
      done = true;
      if (timeoutId !== null) { try { clearTimeout(timeoutId); } catch (e) {} }
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
    timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ outcome: "timeout", error: "measureInWindow timed out (1500ms)" });
    }, 1500);
  } catch (e) {
    resolve({ outcome: "error", error: (e && e.message) || String(e) });
  }
})`;
}
