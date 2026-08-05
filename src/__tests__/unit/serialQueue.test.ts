import { describe, it, expect } from "@jest/globals";
import { createSerialQueue } from "../../core/serialQueue.js";

function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
} {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("createSerialQueue", () => {
    it("never runs two tasks at once", async () => {
        const queue = createSerialQueue();
        let active = 0;
        let maxActive = 0;

        const task = async (): Promise<void> => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
        };

        await Promise.all(Array.from({ length: 8 }, () => queue.run(task)));

        expect(maxActive).toBe(1);
    });

    it("preserves submission order", async () => {
        const queue = createSerialQueue();
        const order: number[] = [];

        await Promise.all(
            [0, 1, 2, 3].map((i) =>
                queue.run(async () => {
                    // Longer delay for earlier items: order must come from the
                    // queue, not from how fast each task happens to finish.
                    await new Promise((r) => setTimeout(r, (4 - i) * 4));
                    order.push(i);
                })
            )
        );

        expect(order).toEqual([0, 1, 2, 3]);
    });

    it("does not start the next task until the previous settles", async () => {
        const queue = createSerialQueue();
        const gate = deferred();
        let secondStarted = false;

        const first = queue.run(() => gate.promise);
        const second = queue.run(async () => {
            secondStarted = true;
        });

        await new Promise((r) => setTimeout(r, 10));
        expect(secondStarted).toBe(false);

        gate.resolve();
        await first;
        await second;
        expect(secondStarted).toBe(true);
    });

    it("a rejecting task does not wedge the queue", async () => {
        const queue = createSerialQueue();

        const failed = queue.run(async () => {
            throw new Error("boom");
        });
        const after = queue.run(async () => "survived");

        await expect(failed).rejects.toThrow("boom");
        await expect(after).resolves.toBe("survived");
    });

    it("surfaces the task's own rejection to its caller", async () => {
        const queue = createSerialQueue();
        await expect(
            queue.run(async () => {
                throw new Error("mine");
            })
        ).rejects.toThrow("mine");
    });

    it("tracks pending depth and drains to zero", async () => {
        const queue = createSerialQueue();
        const gate = deferred();

        expect(queue.pending).toBe(0);

        const a = queue.run(() => gate.promise);
        const b = queue.run(async () => undefined);
        expect(queue.pending).toBe(2);

        gate.resolve();
        await Promise.all([a, b]);
        expect(queue.pending).toBe(0);
    });
});
