import { describe, it, expect } from "@jest/globals";
import { execAsync, withCancelableTimeout } from "../../core/exec.js";

describe("execAsync", () => {
    it("returns stdout/stderr for a successful command", async () => {
        const { stdout, stderr } = await execAsync("printf hello");
        expect(stdout).toBe("hello");
        expect(stderr).toBe("");
    });

    it("rejects when the command fails", async () => {
        await expect(execAsync("exit 7")).rejects.toThrow();
    });

    it("kills the child when the AbortSignal aborts", async () => {
        const ctrl = new AbortController();
        // 5s sleep — must reject within ~600ms once we abort.
        const start = Date.now();
        const p = execAsync("sleep 5", { signal: ctrl.signal });
        setTimeout(() => ctrl.abort(), 50);
        await expect(p).rejects.toThrow();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(1500);
    });

    it("rejects synchronously if the signal is already aborted", async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const start = Date.now();
        await expect(execAsync("sleep 5", { signal: ctrl.signal })).rejects.toThrow();
        expect(Date.now() - start).toBeLessThan(1500);
    });
});

describe("withCancelableTimeout", () => {
    it("resolves when the inner promise resolves before the timeout", async () => {
        const result = await withCancelableTimeout(
            async () => 42,
            1000,
            "test"
        );
        expect(result).toBe(42);
    });

    it("rejects with a labelled timeout error and aborts the signal", async () => {
        let abortedAt = 0;
        const start = Date.now();
        const p = withCancelableTimeout(
            (signal) => new Promise<never>((_, reject) => {
                signal.addEventListener("abort", () => {
                    abortedAt = Date.now();
                    reject(new Error("inner saw abort"));
                });
            }),
            100,
            "myStrategy"
        );
        await expect(p).rejects.toThrow(/myStrategy timed out after 100ms/);
        expect(abortedAt).toBeGreaterThan(0);
        expect(abortedAt - start).toBeGreaterThanOrEqual(80);
        expect(abortedAt - start).toBeLessThan(500);
    });

    it("does not fire the timeout if the inner rejects first", async () => {
        const ownErr = new Error("inner failure");
        await expect(
            withCancelableTimeout(async () => { throw ownErr; }, 1000, "test")
        ).rejects.toBe(ownErr);
    });
});
