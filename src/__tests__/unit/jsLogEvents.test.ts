import { describe, it, expect } from "@jest/globals";
import { jsEventsFromEntries, findJsEvent } from "../../core/jsLogEvents.js";
import type { LogEntry } from "../../core/types.js";

function entry(over: Partial<LogEntry>): LogEntry {
    return {
        timestamp: new Date("2026-07-29T19:10:39.000Z"),
        level: "log",
        message: "Cart updated",
        seq: 12,
        epoch: 1,
        ...over,
    };
}

describe("jsEventsFromEntries", () => {
    it("gives every event a j-prefixed id derived from seq", () => {
        const [event] = jsEventsFromEntries([entry({ seq: 12 })], "iPhone Air");
        expect(event.id).toBe("j12");
        expect(event.source).toBe("js");
    });

    it("classifies an error carrying a stack as an exception", () => {
        const stack = [
            "TypeError: undefined is not an object (evaluating 'user.name')",
            "    at HomeScreen (app/index.tsx:24:11)",
            "    at renderWithHooks (react-dom.js:1234:5)",
        ].join("\n");
        const [event] = jsEventsFromEntries([entry({ level: "error", message: stack })], "iPhone Air");
        expect(event.kind).toBe("exception");
        expect(event.title).toContain("TypeError");
        expect(event.title).toContain("2 frames");
    });

    it("keeps a plain log as a message event", () => {
        const [event] = jsEventsFromEntries([entry({})], "iPhone Air");
        expect(event.kind).toBe("message");
        expect(event.title).toBe("Cart updated");
    });

    it("records byteSize so oversized payloads get a size hint", () => {
        const big = JSON.stringify({ cart: Array.from({ length: 500 }, (_, i) => ({ id: i })) });
        const [event] = jsEventsFromEntries([entry({ message: big })], "iPhone Air");
        expect(event.byteSize).toBe(big.length);
        expect(event.lineCount).toBe(1);
    });

    it("truncates a long single-line title but keeps the payload intact", () => {
        const big = "x".repeat(5000);
        const [event] = jsEventsFromEntries([entry({ message: big })], "iPhone Air");
        expect(event.title.length).toBeLessThan(200);
        expect(event.lines[0].raw).toHaveLength(5000);
    });
});

describe("findJsEvent", () => {
    it("returns undefined for a bare 'j' id instead of resolving to seq 0", () => {
        // Number("") === 0, which passes Number.isFinite and used to search
        // for seq === 0 — harmless only because nextSeq starts at 1, so this
        // was a latent bug masked by an unrelated detail.
        expect(findJsEvent("j")).toBeUndefined();
    });

    it("still returns undefined for a non-numeric id", () => {
        expect(findJsEvent("jabc")).toBeUndefined();
    });
});
