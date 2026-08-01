import { describe, expect, it } from "@jest/globals";
import { readKeyboardState, type KeyboardExecuteFn } from "../../core/keyboardMetrics.js";

const exec = (payload: unknown): KeyboardExecuteFn => async () => ({
    success: true,
    result: JSON.stringify(payload)
});

describe("readKeyboardState", () => {
    it("reports a visible keyboard with its metrics", async () => {
        const s = await readKeyboardState(
            undefined,
            exec({ visible: true, metrics: { height: 345, screenY: 567, width: 420 } })
        );
        expect(s).toMatchObject({ visible: true, height: 345, screenY: 567, width: 420 });
        expect(s.error).toBeUndefined();
    });

    it("handles metrics() returning undefined while hidden", async () => {
        // Verified on device 2026-08-01: RN's Keyboard.metrics() is undefined when
        // the keyboard is down, so the shape is checked rather than assumed.
        const s = await readKeyboardState(undefined, exec({ visible: false }));
        expect(s).toMatchObject({ visible: false, height: null, screenY: null, width: null });
        expect(s.error).toBeUndefined();
    });

    it("degrades to not-visible with a reason when the module is unreachable", async () => {
        const s = await readKeyboardState(undefined, exec({ error: "no Keyboard module" }));
        expect(s.visible).toBe(false);
        expect(s.error).toBe("no Keyboard module");
    });

    it("degrades when the executor itself fails", async () => {
        const s = await readKeyboardState(undefined, async () => ({
            success: false,
            error: "No apps connected"
        }));
        expect(s.visible).toBe(false);
        expect(s.error).toBe("No apps connected");
    });

    it("degrades when the payload is not parseable", async () => {
        const s = await readKeyboardState(undefined, async () => ({ success: true, result: "not json" }));
        expect(s.visible).toBe(false);
        expect(s.error).toContain("parse");
    });

    it("reaches the Keyboard module through the injected require", async () => {
        let seen = "";
        const spy: KeyboardExecuteFn = async (expression) => {
            seen = expression;
            return { success: true, result: JSON.stringify({ visible: false }) };
        };
        await readKeyboardState(undefined, spy);
        expect(seen).toContain("require('react-native')");
        expect(seen).toContain("Keyboard");
    });

    it("threads the device argument through", async () => {
        let seen: string | undefined;
        const spy: KeyboardExecuteFn = async (_e, device) => {
            seen = device;
            return { success: true, result: JSON.stringify({ visible: false }) };
        };
        await readKeyboardState("iPhone Air", spy);
        expect(seen).toBe("iPhone Air");
    });
});
