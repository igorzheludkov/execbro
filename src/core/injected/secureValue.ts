/**
 * A `secureTextEntry` field's value never leaves the app as text. The field's own
 * semantics say "do not show", so this applies even with EXECBRO_REDACT=off, and it
 * runs in the app (Hermes) before the value is serialized, so no server-side path
 * can print it by accident. Same rule as chromiumScreen's safeValue for
 * `type=password`.
 *
 * Self-contained on purpose: SECURE_VALUE_JS injects it with toString().
 */
export function maskSecureValue(props: unknown, value: unknown): unknown {
    var secure = !!props && typeof props === "object" && (props as { secureTextEntry?: unknown }).secureTextEntry === true;
    if (secure && typeof value === "string" && value.length > 0) return "[masked, " + value.length + " chars]";
    return value;
}

export const SECURE_VALUE_JS = `var maskSecureValue = ${maskSecureValue.toString()};`;
