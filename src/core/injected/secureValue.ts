/**
 * A `secureTextEntry` field's value never leaves the app as text. The field's own
 * semantics say "do not show", so this applies even with EXECBRO_REDACT=off, and it
 * runs in the app (Hermes) before the value is serialized, so no server-side path
 * can print it by accident. Same rule as chromiumScreen's safeValue for
 * `type=password`.
 *
 * The flag is looked for on the props given AND in the fiber's subtree: the ordinary
 * show/hide-password component is a wrapper holding `value` / `onChangeText` that
 * renders `<TextInput secureTextEntry={!shown}>` below it, so the wrapper itself
 * never carries the flag.
 *
 * Self-contained on purpose: SECURE_VALUE_JS injects it with toString().
 */
export function maskSecureValue(props: unknown, value: unknown, fiber?: unknown): unknown {
    function secureBelow(f: any, d: number): boolean {
        if (!f || d > 10) return false;
        var p = f.memoizedProps;
        if (p && typeof p === "object" && p.secureTextEntry === true) return true;
        var c = f.child;
        while (c) {
            if (secureBelow(c, d + 1)) return true;
            c = c.sibling;
        }
        return false;
    }
    var secure = (!!props && typeof props === "object" && (props as { secureTextEntry?: unknown }).secureTextEntry === true) || secureBelow(fiber, 0);
    if (secure && typeof value === "string" && value.length > 0) return "[masked, " + value.length + " chars]";
    return value;
}

export const SECURE_VALUE_JS = `var maskSecureValue = ${maskSecureValue.toString()};`;
