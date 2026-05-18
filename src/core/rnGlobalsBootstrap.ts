import { executeInApp } from "./jsExecute.js";
import { bootstrappedApps, connectedApps } from "./state.js";

/**
 * Best-effort fiber walk that probes for the seven curated RN modules
 * by shape signature. Hermes does not expose closure-captured variables,
 * so this fallback almost always sets globalThis.__rn__ = null. Apps that
 * install react-native-ai-devtools-sdk get the namespace populated directly
 * via the SDK's exposeRnGlobals() — that's the preferred path. This walk
 * is here so list_debug_globals can report the failure clearly.
 */
export function buildRnGlobalsBootstrapExpression(): string {
    // Hermes-compatible IIFE: scans every fiber's memoizedProps / stateNode /
    // memoizedState for objects whose own keys match one of the curated
    // module signatures. Stops on first match per module.
    return `(() => {
        try {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook || typeof hook.getFiberRoots !== "function") {
                globalThis.__rn__ = null;
                globalThis.__rn__bootstrap_failed = true;
                return { ok: false, reason: "no devtools hook" };
            }
            const found = {};
            const isObj = (v) => v && typeof v === "object";
            const has = (v, k) => isObj(v) && Object.prototype.hasOwnProperty.call(v, k);
            const isFn = (v, k) => has(v, k) && typeof v[k] === "function";
            const matchers = [
                ["I18nManager", (v) => isObj(v) && typeof v.isRTL === "boolean"],
                ["PixelRatio", (v) => isFn(v, "getFontScale")],
                ["Platform", (v) => isObj(v) && typeof v.OS === "string"],
                ["StyleSheet", (v) => isFn(v, "flatten") && isFn(v, "create")],
                ["AppRegistry", (v) => isFn(v, "registerComponent") || isFn(v, "getAppKeys")],
                ["NativeModules", (v) => isObj(v) && (has(v, "PlatformConstants") || has(v, "UIManager"))],
                ["Dimensions", (v) => isFn(v, "get") && isFn(v, "set")],
            ];
            const probe = (v) => {
                if (!isObj(v)) return;
                for (let i = 0; i < matchers.length; i++) {
                    const [name, test] = matchers[i];
                    if (!found[name] && test(v)) found[name] = v;
                }
            };
            const seen = new WeakSet();
            const visit = (fiber, depth) => {
                if (!fiber || depth > 200) return;
                if (seen.has(fiber)) return;
                seen.add(fiber);
                probe(fiber.memoizedProps);
                probe(fiber.stateNode);
                probe(fiber.memoizedState);
                if (fiber.child) visit(fiber.child, depth + 1);
                if (fiber.sibling) visit(fiber.sibling, depth + 1);
            };
            const roots = hook.getFiberRoots(1) || hook.getFiberRoots(0);
            if (roots && roots.forEach) {
                roots.forEach((root) => {
                    if (root && root.current) visit(root.current, 0);
                });
            }
            const keys = Object.keys(found);
            if (keys.length === 0) {
                globalThis.__rn__ = null;
                globalThis.__rn__bootstrap_failed = true;
                return { ok: false, reason: "no fiber matched" };
            }
            globalThis.__rn__ = found;
            return { ok: true, keys: keys };
        } catch (e) {
            globalThis.__rn__ = null;
            globalThis.__rn__bootstrap_failed = true;
            return { ok: false, reason: String(e) };
        }
    })()`;
}

/**
 * Run the bootstrap once per app session. Failures are swallowed (the marker
 * on globalThis is enough for list_debug_globals). Uses skipBootstrap: true
 * on the inner executeInApp call to prevent infinite recursion.
 */
export async function ensureRnGlobalsBootstrap(device?: string): Promise<void> {
    let key: string;
    if (device) {
        key = device;
    } else {
        const firstKey = connectedApps.keys().next().value;
        if (!firstKey) return;
        key = firstKey;
    }
    if (bootstrappedApps.has(key)) return;
    bootstrappedApps.add(key);
    try {
        await executeInApp(
            buildRnGlobalsBootstrapExpression(),
            false,
            { maxRetries: 0, autoReconnect: false, skipBootstrap: true },
            device
        );
    } catch (e) {
        console.error("[execbro] __rn__ bootstrap failed:", e);
    }
}
