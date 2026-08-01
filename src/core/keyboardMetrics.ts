import { executeInApp } from "./executor.js";
import type { ExecutionResult } from "./types.js";

export type KeyboardState = {
    visible: boolean;
    height: number | null;
    screenY: number | null;
    width: number | null;
    error?: string;
};

export type KeyboardExecuteFn = (expression: string, device?: string) => Promise<ExecutionResult>;

const defaultExecute: KeyboardExecuteFn = (expression, device) =>
    executeInApp(expression, true, { originatingToolName: "keyboard_metrics" }, device);

/**
 * RN's own Keyboard module, reached through the injected Metro module registry.
 * One cross-platform path, no shelling out, no permissions — verified on both
 * platforms 2026-08-01.
 *
 * metrics() returns undefined while the keyboard is hidden, so the shape is
 * checked rather than assumed.
 */
const EXPRESSION = `(function () {
  var RN = require('react-native');
  if (!RN || !RN.Keyboard) return { error: 'Keyboard module unavailable (Metro module registry not reachable)' };
  var m = typeof RN.Keyboard.metrics === 'function' ? RN.Keyboard.metrics() : null;
  var v = typeof RN.Keyboard.isVisible === 'function' ? RN.Keyboard.isVisible() : false;
  return { visible: !!v, metrics: m || null };
})()`;

export async function readKeyboardState(
    device?: string,
    execute: KeyboardExecuteFn = defaultExecute
): Promise<KeyboardState> {
    const hidden: KeyboardState = { visible: false, height: null, screenY: null, width: null };

    const exec = await execute(EXPRESSION, device);
    if (!exec.success) return { ...hidden, error: exec.error ?? "executor failed" };

    let parsed: {
        visible?: boolean;
        metrics?: { height?: number; screenY?: number; width?: number } | null;
        error?: string;
    };
    try {
        parsed = JSON.parse(exec.result ?? "");
    } catch {
        return { ...hidden, error: `could not parse keyboard metrics: ${String(exec.result).slice(0, 120)}` };
    }

    if (parsed.error) return { ...hidden, error: parsed.error };

    const m = parsed.metrics ?? null;
    return {
        visible: !!parsed.visible,
        height: m?.height ?? null,
        screenY: m?.screenY ?? null,
        width: m?.width ?? null
    };
}
