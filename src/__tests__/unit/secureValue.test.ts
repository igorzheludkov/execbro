import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { maskSecureValue, SECURE_VALUE_JS } from "../../core/injected/secureValue.js";

describe("maskSecureValue", () => {
    it("masks a secureTextEntry value with its length", () => {
        expect(maskSecureValue({ secureTextEntry: true }, "pw-mgoOS_8UksAuQF0w")).toBe("[masked, 19 chars]");
    });

    it("leaves ordinary inputs alone", () => {
        expect(maskSecureValue({}, "qa.buyer@shop.dev")).toBe("qa.buyer@shop.dev");
    });

    it("passes empty and non-string values through", () => {
        expect(maskSecureValue({ secureTextEntry: true }, "")).toBe("");
        expect(maskSecureValue({ secureTextEntry: true }, null)).toBe(null);
    });

    it("masks a wrapper whose secure TextInput sits below it", () => {
        // <PasswordInput value onChangeText /> rendering <TextInput secureTextEntry={!shown} />:
        // the wrapper carries the value but not the flag.
        const inner = { memoizedProps: { secureTextEntry: true }, child: null, sibling: null };
        const wrapper = { memoizedProps: { value: "hunter22" }, child: { memoizedProps: {}, child: inner, sibling: null }, sibling: null };
        expect(maskSecureValue(wrapper.memoizedProps, "hunter22", wrapper)).toBe("[masked, 8 chars]");
    });

    it("does not mask when nothing in the subtree is secure", () => {
        const plain = { memoizedProps: { value: "a" }, child: { memoizedProps: { secureTextEntry: false }, child: null, sibling: null }, sibling: null };
        expect(maskSecureValue(plain.memoizedProps, "a", plain)).toBe("a");
    });

    it("injected source defines the same function", () => {
        const fn = new Function(`${SECURE_VALUE_JS}; return maskSecureValue;`)();
        expect(fn({ secureTextEntry: true }, "abc")).toBe("[masked, 3 chars]");
    });
});

describe("input values are read through maskSecureValue", () => {
    // Drift guard, same shape as fiberRootsDrift.test.ts: every injected reader of an
    // input's value must go through the helper, or the next walker leaks a password.
    const SRC = join(process.cwd(), "src");
    const walk = (d: string): string[] =>
        readdirSync(d).flatMap((n) => {
            const p = join(d, n);
            return statSync(p).isDirectory() ? (n === "__tests__" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : [];
        });

    // Not fiber input readers: chromium masks passwords with its own safeValue/maskPw,
    // and connection.ts reads a CDP exception object.
    const ALLOWED = new Set([join("core", "injected", "secureValue.ts"), join("core", "chromium.ts"), join("core", "connection.ts")]);

    // Narrowed to string reads: `p.value` is also a navigation context value, a Switch's
    // boolean and a CDP RemoteObject field, none of which can carry typed text.
    it("no injected source reads a string props.value / props.defaultValue without the helper on the same line", () => {
        const offenders: string[] = [];
        for (const p of walk(SRC)) {
            if (ALLOWED.has(relative(SRC, p))) continue;
            readFileSync(p, "utf8").split("\n").forEach((line, i) => {
                if (/typeof\s+\w+\.(value|defaultValue)\s*===\s*['"]string['"]/.test(line) && !line.includes("maskSecureValue")) {
                    offenders.push(`${relative(SRC, p)}:${i + 1}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });
});
