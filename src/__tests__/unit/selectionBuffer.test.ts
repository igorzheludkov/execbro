import { describe, it, expect, beforeEach } from "@jest/globals";
import { SelectionBuffer } from "../../core/selectionBuffer.js";
import type { SelectionEntry } from "../../core/selectionBuffer.js";

let counter = 0;
function makeEntry(overrides: Partial<SelectionEntry> = {}): SelectionEntry {
    counter += 1;
    return {
        id: overrides.id ?? `sel-${counter}`,
        device: overrides.device ?? "iPhone Air",
        timestamp: overrides.timestamp ?? 1000 + counter,
        element: overrides.element ?? "Text",
        path: overrides.path ?? "App > HomeScreen > Text",
        hierarchy: overrides.hierarchy ?? ["App", "HomeScreen", "Text"],
        frame: overrides.frame ?? { left: 10, top: 20, width: 30, height: 40 },
        style: overrides.style ?? null,
        stacks: overrides.stacks ?? [],
    };
}

describe("SelectionBuffer", () => {
    let buffer: SelectionBuffer;

    beforeEach(() => {
        buffer = new SelectionBuffer(3);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
        expect(buffer.list()).toEqual([]);
        expect(buffer.latest()).toBeUndefined();
    });

    it("adds an entry and reports it as accepted", () => {
        expect(buffer.add(makeEntry({ id: "a" }))).toBe(true);
        expect(buffer.size).toBe(1);
    });

    it("evicts oldest beyond max size", () => {
        buffer.add(makeEntry({ id: "a", path: "p-a" }));
        buffer.add(makeEntry({ id: "b", path: "p-b" }));
        buffer.add(makeEntry({ id: "c", path: "p-c" }));
        buffer.add(makeEntry({ id: "d", path: "p-d" }));
        expect(buffer.size).toBe(3);
        expect(buffer.list().map((e) => e.id)).toEqual(["d", "c", "b"]);
    });

    it("lists newest first", () => {
        buffer.add(makeEntry({ id: "a", path: "p-a" }));
        buffer.add(makeEntry({ id: "b", path: "p-b" }));
        expect(buffer.list().map((e) => e.id)).toEqual(["b", "a"]);
    });

    it("rejects a duplicate of the most recent entry on the same device", () => {
        buffer.add(makeEntry({ id: "a", path: "same", frame: { left: 1, top: 2, width: 3, height: 4 } }));
        const accepted = buffer.add(
            makeEntry({ id: "b", path: "same", frame: { left: 1, top: 2, width: 3, height: 4 } })
        );
        expect(accepted).toBe(false);
        expect(buffer.size).toBe(1);
    });

    it("accepts a repeat of the same element on a different device", () => {
        buffer.add(makeEntry({ id: "a", path: "same", device: "iPhone Air" }));
        const accepted = buffer.add(makeEntry({ id: "b", path: "same", device: "Pixel 7" }));
        expect(accepted).toBe(true);
        expect(buffer.size).toBe(2);
    });

    it("accepts the same path again once another selection intervened", () => {
        buffer.add(makeEntry({ id: "a", path: "one" }));
        buffer.add(makeEntry({ id: "b", path: "two" }));
        expect(buffer.add(makeEntry({ id: "c", path: "one" }))).toBe(true);
        expect(buffer.size).toBe(3);
    });

    it("filters by device", () => {
        buffer.add(makeEntry({ id: "a", device: "iPhone Air", path: "p-a" }));
        buffer.add(makeEntry({ id: "b", device: "Pixel 7", path: "p-b" }));
        expect(buffer.list({ device: "Pixel 7" }).map((e) => e.id)).toEqual(["b"]);
    });

    it("honours limit", () => {
        buffer.add(makeEntry({ id: "a", path: "p-a" }));
        buffer.add(makeEntry({ id: "b", path: "p-b" }));
        expect(buffer.list({ limit: 1 }).map((e) => e.id)).toEqual(["b"]);
    });

    it("latest respects the device filter", () => {
        buffer.add(makeEntry({ id: "a", device: "iPhone Air", path: "p-a" }));
        buffer.add(makeEntry({ id: "b", device: "Pixel 7", path: "p-b" }));
        expect(buffer.latest("iPhone Air")!.id).toBe("a");
        expect(buffer.latest()!.id).toBe("b");
    });

    it("clear empties the buffer", () => {
        buffer.add(makeEntry({ id: "a" }));
        buffer.clear();
        expect(buffer.size).toBe(0);
        expect(buffer.latest()).toBeUndefined();
    });
});
