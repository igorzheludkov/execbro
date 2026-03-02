import { describe, it, expect } from "@jest/globals";
import { NetworkBuffer } from "../../core/network.js";
import { NetworkRequest } from "../../core/types.js";

function makeRequest(id: string, overrides: Partial<NetworkRequest> = {}): NetworkRequest {
    return {
        requestId: id,
        timestamp: new Date(),
        method: "GET",
        url: `https://api.example.com/${id}`,
        headers: {},
        completed: false,
        ...overrides,
    };
}

describe("NetworkBuffer", () => {
    let buffer: NetworkBuffer;

    beforeEach(() => {
        buffer = new NetworkBuffer(5);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
    });

    it("set and get a request", () => {
        const req = makeRequest("1");
        buffer.set("1", req);
        expect(buffer.get("1")).toBe(req);
        expect(buffer.size).toBe(1);
    });

    it("updates existing request without increasing size", () => {
        buffer.set("1", makeRequest("1"));
        buffer.set("1", makeRequest("1", { status: 200, completed: true }));
        expect(buffer.size).toBe(1);
        expect(buffer.get("1")?.status).toBe(200);
    });

    it("evicts oldest when exceeding maxSize", () => {
        for (let i = 0; i < 7; i++) {
            buffer.set(`${i}`, makeRequest(`${i}`));
        }
        expect(buffer.size).toBe(5);
        expect(buffer.get("0")).toBeUndefined();
        expect(buffer.get("1")).toBeUndefined();
        expect(buffer.get("2")).toBeDefined();
    });

    it("getAll() filters by method", () => {
        buffer.set("1", makeRequest("1", { method: "GET" }));
        buffer.set("2", makeRequest("2", { method: "POST" }));
        const posts = buffer.getAll({ method: "POST" });
        expect(posts).toHaveLength(1);
        expect(posts[0].method).toBe("POST");
    });

    it("getAll() filters by method case-insensitively", () => {
        buffer.set("1", makeRequest("1", { method: "GET" }));
        const results = buffer.getAll({ method: "get" });
        expect(results).toHaveLength(1);
    });

    it("getAll() filters by urlPattern (case-insensitive substring)", () => {
        buffer.set("1", makeRequest("1", { url: "https://api.example.com/users" }));
        buffer.set("2", makeRequest("2", { url: "https://api.example.com/posts" }));
        const results = buffer.getAll({ urlPattern: "users" });
        expect(results).toHaveLength(1);
    });

    it("getAll() filters by status", () => {
        buffer.set("1", makeRequest("1", { status: 200 }));
        buffer.set("2", makeRequest("2", { status: 404 }));
        const results = buffer.getAll({ status: 200 });
        expect(results).toHaveLength(1);
    });

    it("getAll() filters completedOnly", () => {
        buffer.set("1", makeRequest("1", { completed: true }));
        buffer.set("2", makeRequest("2", { completed: false }));
        const results = buffer.getAll({ completedOnly: true });
        expect(results).toHaveLength(1);
    });

    it("getAll() limits count (takes last N)", () => {
        for (let i = 0; i < 5; i++) {
            buffer.set(`${i}`, makeRequest(`${i}`));
        }
        const results = buffer.getAll({ count: 2 });
        expect(results).toHaveLength(2);
    });

    it("getAll() sorts by timestamp", () => {
        const earlier = new Date("2024-01-01T00:00:00Z");
        const later = new Date("2024-01-01T01:00:00Z");
        buffer.set("late", makeRequest("late", { timestamp: later }));
        buffer.set("early", makeRequest("early", { timestamp: earlier }));
        const results = buffer.getAll({});
        expect(results[0].requestId).toBe("early");
        expect(results[1].requestId).toBe("late");
    });

    it("search() finds by URL pattern", () => {
        buffer.set("1", makeRequest("1", { url: "https://api.example.com/users" }));
        buffer.set("2", makeRequest("2", { url: "https://api.example.com/posts" }));
        const results = buffer.search("users");
        expect(results).toHaveLength(1);
    });

    it("clear() empties buffer and returns count", () => {
        buffer.set("1", makeRequest("1"));
        buffer.set("2", makeRequest("2"));
        expect(buffer.clear()).toBe(2);
        expect(buffer.size).toBe(0);
    });
});
