import { describe, expect, it, jest } from "@jest/globals";
import { measureComponent, type ExecuteFn } from "../../core/measureComponentTools.js";
import type { ExecutionResult } from "../../core/types.js";

const ok = (payload: unknown): ExecutionResult => ({
    success: true,
    result: JSON.stringify(payload)
});

describe("measureComponent", () => {
    it("returns success with bounds when executor reports measured", async () => {
        const execute = jest.fn<ExecuteFn>(async () =>
            ok({ outcome: "measured", x: 10, y: 20, width: 100, height: 50, name: "SneakerCard", nativeTag: 42 })
        );
        const result = await measureComponent("SneakerCard", 0, undefined, execute);
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.x).toBe(10);
        expect(result.y).toBe(20);
        expect(result.width).toBe(100);
        expect(result.height).toBe(50);
        expect(result.name).toBe("SneakerCard");
        expect(result.nativeTag).toBe(42);
        expect(result.outcome).toBe("measured");
    });

    it("omits nativeTag when not present", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ok({ outcome: "measured", x: 0, y: 0, width: 1, height: 1, name: "X" }));
        const result = await measureComponent("X", 0, undefined, execute);
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect("nativeTag" in result ? result.nativeTag : undefined).toBeUndefined();
    });

    it("passes componentName and index to the built expression", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ok({ outcome: "no_match", error: "no component matched 'Foo'" }));
        await measureComponent("Foo", 7, undefined, execute);
        const expr = (execute.mock.calls[0] as unknown[])[0] as string;
        expect(expr).toContain("Foo");
        expect(expr).toContain("7");
    });

    it("forwards the device argument to the executor", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ok({ outcome: "no_match", error: "x" }));
        await measureComponent("Foo", 0, "iPhone Air", execute);
        expect(execute).toHaveBeenCalledWith(expect.any(String), "iPhone Air");
    });

    it("returns no_match outcome unchanged", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ok({ outcome: "no_match", error: "no component matched 'Foo'" }));
        const result = await measureComponent("Foo", 0, undefined, execute);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.outcome).toBe("no_match");
        expect(result.error).toContain("no component matched");
    });

    it("returns no_host_descendant outcome unchanged", async () => {
        const execute = jest.fn<ExecuteFn>(async () =>
            ok({ outcome: "no_host_descendant", error: "has no measurable stateNode at index 0" })
        );
        const result = await measureComponent("Wrapper", 0, undefined, execute);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.outcome).toBe("no_host_descendant");
    });

    it("returns timeout outcome unchanged", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ok({ outcome: "timeout", error: "measureInWindow timed out (1500ms)" }));
        const result = await measureComponent("X", 0, undefined, execute);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.outcome).toBe("timeout");
    });

    it("returns error outcome when executor reports failure", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ({ success: false, error: "No apps connected" }) as ExecutionResult);
        const result = await measureComponent("X", 0, undefined, execute);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.outcome).toBe("error");
        expect(result.error).toContain("No apps connected");
    });

    it("returns error outcome when executor result is unparseable", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ({ success: true, result: "not-json" }) as ExecutionResult);
        const result = await measureComponent("X", 0, undefined, execute);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.outcome).toBe("error");
        expect(result.error).toMatch(/parse/i);
    });

    it("defaults index to 0 when omitted", async () => {
        const execute = jest.fn<ExecuteFn>(async () => ok({ outcome: "no_match", error: "x" }));
        await measureComponent("X", undefined as unknown as number, undefined, execute);
        const expr = (execute.mock.calls[0] as unknown[])[0] as string;
        // The interpolated `targetIndex = …;` literal must be 0, not the string "undefined".
        expect(expr).toContain("targetIndex = 0;");
        expect(expr).not.toContain("targetIndex = undefined");
    });
});
