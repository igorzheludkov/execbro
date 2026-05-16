import { describe, expect, it, jest } from "@jest/globals";
import { clearFocusedInput, dismissKeyboard, type ExecuteFn } from "../../core/focusedInputTools.js";

const okExecute = (result: unknown): ExecuteFn =>
    jest.fn(async () => ({ success: true, result: JSON.stringify(result) }));

const errExecute = (error: string): ExecuteFn => jest.fn(async () => ({ success: false, error }));

describe("clearFocusedInput", () => {
    it("returns success when executor reports cleared via onChangeText", async () => {
        const result = await clearFocusedInput(undefined, okExecute({ cleared: true, via: "onChangeText" }));
        expect(result.success).toBe(true);
        expect(result.via).toBe("onChangeText");
    });

    it("returns success with fallback flag when via=publicInstance", async () => {
        const result = await clearFocusedInput(undefined, okExecute({ cleared: true, via: "publicInstance" }));
        expect(result.success).toBe(true);
        expect(result.via).toBe("publicInstance");
    });

    it("returns failure when no input focused", async () => {
        const result = await clearFocusedInput(
            undefined,
            okExecute({ cleared: false, reason: "no focused TextInput" })
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("no focused TextInput");
    });

    it("returns failure when executor itself fails", async () => {
        const result = await clearFocusedInput(undefined, errExecute("No apps connected. Run 'scan_metro' first."));
        expect(result.success).toBe(false);
        expect(result.error).toContain("No apps connected");
    });

    it("passes the device argument through to the executor", async () => {
        const exec = jest.fn<ExecuteFn>(async () => ({
            success: true,
            result: JSON.stringify({ cleared: true, via: "onChangeText" })
        }));
        await clearFocusedInput("iPhone 15", exec);
        expect(exec).toHaveBeenCalledWith(expect.any(String), "iPhone 15");
    });
});

describe("dismissKeyboard", () => {
    it("returns success with nativeTag on dismiss", async () => {
        const result = await dismissKeyboard(undefined, okExecute({ dismissed: true, nativeTag: 42 }));
        expect(result.success).toBe(true);
        expect(result.nativeTag).toBe(42);
    });

    it("returns failure when nothing focused", async () => {
        const result = await dismissKeyboard(
            undefined,
            okExecute({ dismissed: false, reason: "no focused TextInput" })
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("no focused TextInput");
    });
});
