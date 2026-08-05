import { describe, it, expect, beforeEach } from "@jest/globals";
import { NetworkBuffer } from "../../core/network.js";
import { buildReplayArgs } from "../../core/replay.js";
import { buildRequestExpression } from "../../core/appRequest.js";
import { UserInputError } from "../../core/errors.js";

describe("buildReplayArgs", () => {
    let buffer: NetworkBuffer;
    beforeEach(() => {
        buffer = new NetworkBuffer(10);
        buffer.set("js-1", {
            requestId: "js-1",
            timestamp: new Date(),
            method: "POST",
            url: "https://api.example.com/orders",
            headers: { "Content-Type": "application/json" },
            postData: '{"qty":1}',
            completed: true,
            epoch: 1
        });
    });

    it("rebuilds the original call from the buffer entry", () => {
        expect(buildReplayArgs(buffer, "js-1", {})).toEqual({
            method: "POST",
            url: "https://api.example.com/orders",
            headers: { "Content-Type": "application/json" },
            body: '{"qty":1}'
        });
    });

    it("applies overrides on top of the captured values", () => {
        const out = buildReplayArgs(buffer, "js-1", { body: '{"qty":99}', method: "PUT" });
        expect(out.method).toBe("PUT");
        expect(out.body).toBe('{"qty":99}');
        expect(out.url).toBe("https://api.example.com/orders");
    });

    it("throws a useful error for an unknown id", () => {
        expect(() => buildReplayArgs(buffer, "js-nope", {})).toThrow(/js-nope/);
        expect(() => buildReplayArgs(buffer, "js-nope", {})).toThrow(UserInputError);
    });

    it("replaces headers wholesale rather than merging, so a header can be dropped", () => {
        const out = buildReplayArgs(buffer, "js-1", { headers: { "X-Only": "1" } });
        expect(out.headers).toEqual({ "X-Only": "1" });
    });

    it("carries no body when the captured request had none", () => {
        buffer.set("js-2", {
            requestId: "js-2",
            timestamp: new Date(),
            method: "GET",
            url: "https://api.example.com/me",
            headers: {},
            completed: true,
            epoch: 1
        });
        expect(buildReplayArgs(buffer, "js-2", {}).body).toBeUndefined();
    });
});

describe("replay body round-trip", () => {
    it("sends the captured body verbatim instead of re-encoding it", () => {
        // The captured postData is already a wire string. Feeding it through
        // the JSON-serialising `body` option would send the string "{...}"
        // wrapped in quotes — a valid request that means something else.
        const expression = buildRequestExpression({
            method: "POST",
            url: "https://api.example.com/orders",
            rawBody: '{"qty":1}',
            auth: "none"
        });
        expect(expression).toContain('var bodyText = "{\\"qty\\":1}"');
        expect(expression).not.toContain('"{\\\\"qty\\\\":1}"');
    });

    it("still JSON-encodes a structured body passed the normal way", () => {
        const expression = buildRequestExpression({
            method: "POST",
            url: "https://x/y",
            body: { qty: 1 },
            auth: "none"
        });
        expect(expression).toContain('var bodyText = "{\\"qty\\":1}"');
    });

    it("a non-JSON captured body survives verbatim", () => {
        const expression = buildRequestExpression({
            method: "POST",
            url: "https://x/y",
            rawBody: "a=1&b=2",
            auth: "none"
        });
        expect(expression).toContain('var bodyText = "a=1&b=2"');
    });
});
