import { LogBuffer, mapConsoleType } from "../../core/logs.js";
import { LogEntry } from "../../core/types.js";

function makeLog(message: string, level: LogEntry["level"] = "log"): LogEntry {
    return { timestamp: new Date(), level, message };
}

describe("LogBuffer", () => {
    let buffer: LogBuffer;

    beforeEach(() => {
        buffer = new LogBuffer(5);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
        expect(buffer.getAll()).toEqual([]);
    });

    it("adds and retrieves logs", () => {
        buffer.add(makeLog("hello"));
        expect(buffer.size).toBe(1);
        expect(buffer.getAll()[0].message).toBe("hello");
    });

    it("evicts oldest when exceeding maxSize", () => {
        for (let i = 0; i < 7; i++) {
            buffer.add(makeLog(`msg-${i}`));
        }
        expect(buffer.size).toBe(5);
        expect(buffer.getAll()[0].message).toBe("msg-2");
        expect(buffer.getAll()[4].message).toBe("msg-6");
    });

    it("get() limits count", () => {
        for (let i = 0; i < 5; i++) buffer.add(makeLog(`msg-${i}`));
        const result = buffer.get(2);
        expect(result).toHaveLength(2);
    });

    it("get() filters by level", () => {
        buffer.add(makeLog("info msg", "info"));
        buffer.add(makeLog("error msg", "error"));
        buffer.add(makeLog("warn msg", "warn"));
        const errors = buffer.get(undefined, "error");
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe("error msg");
    });

    it("get() with startFromText finds last match and returns from there", () => {
        buffer.add(makeLog("start"));
        buffer.add(makeLog("marker"));
        buffer.add(makeLog("after1"));
        buffer.add(makeLog("marker"));
        buffer.add(makeLog("after2"));
        const result = buffer.get(undefined, undefined, "marker");
        expect(result).toHaveLength(2);
        expect(result[0].message).toBe("marker");
        expect(result[1].message).toBe("after2");
    });

    it("search() is case-insensitive", () => {
        buffer.add(makeLog("Hello World"));
        buffer.add(makeLog("goodbye"));
        const results = buffer.search("hello");
        expect(results).toHaveLength(1);
        expect(results[0].message).toBe("Hello World");
    });

    it("search() limits maxResults", () => {
        for (let i = 0; i < 5; i++) buffer.add(makeLog("match"));
        expect(buffer.search("match", 2)).toHaveLength(2);
    });

    it("clear() empties buffer and returns count", () => {
        buffer.add(makeLog("a"));
        buffer.add(makeLog("b"));
        const cleared = buffer.clear();
        expect(cleared).toBe(2);
        expect(buffer.size).toBe(0);
    });
});

describe("mapConsoleType", () => {
    it("maps error to error", () => expect(mapConsoleType("error")).toBe("error"));
    it("maps warning to warn", () => expect(mapConsoleType("warning")).toBe("warn"));
    it("maps warn to warn", () => expect(mapConsoleType("warn")).toBe("warn"));
    it("maps info to info", () => expect(mapConsoleType("info")).toBe("info"));
    it("maps debug to debug", () => expect(mapConsoleType("debug")).toBe("debug"));
    it("maps unknown to log", () => expect(mapConsoleType("trace")).toBe("log"));
});
