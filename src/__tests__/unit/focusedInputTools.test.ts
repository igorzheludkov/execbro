import { describe, expect, it, jest } from "@jest/globals";
import {
    clearFocusedInput,
    dismissKeyboard,
    inputTextWithReplace,
    type ClearFocusedInputToolResult,
    type ExecuteFn,
    type TypeResult
} from "../../core/focusedInputTools.js";

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

describe("inputTextWithReplace", () => {
    it("calls the clear fn before the type fn when replace=true", async () => {
        const order: string[] = [];
        const clearFn = jest.fn(async (): Promise<ClearFocusedInputToolResult> => {
            order.push("clear");
            return { success: true, via: "onChangeText" };
        });
        const typeFn = jest.fn(async (_t: string): Promise<TypeResult> => {
            order.push("type");
            return { success: true, result: "ok" };
        });

        const res = await inputTextWithReplace("hello", true, typeFn, clearFn);
        expect(res.success).toBe(true);
        expect(order).toEqual(["clear", "type"]);
        expect(typeFn).toHaveBeenCalledWith("hello");
    });

    it("skips clear when replace=false", async () => {
        const clearFn = jest.fn(async (): Promise<ClearFocusedInputToolResult> => ({ success: true }));
        const typeFn = jest.fn(async (): Promise<TypeResult> => ({ success: true, result: "ok" }));

        await inputTextWithReplace("hello", false, typeFn, clearFn);
        expect(clearFn).not.toHaveBeenCalled();
        expect(typeFn).toHaveBeenCalled();
    });

    it("returns the clear error and does NOT type when clear fails", async () => {
        const clearFn = jest.fn(
            async (): Promise<ClearFocusedInputToolResult> => ({ success: false, error: "no focused TextInput" })
        );
        const typeFn = jest.fn(async (): Promise<TypeResult> => ({ success: true, result: "ok" }));

        const res = await inputTextWithReplace("hello", true, typeFn, clearFn);
        expect(res.success).toBe(false);
        expect(res.error).toContain("no focused TextInput");
        expect(typeFn).not.toHaveBeenCalled();
    });
});
