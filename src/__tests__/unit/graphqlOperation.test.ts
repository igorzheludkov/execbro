import { describe, it, expect } from "@jest/globals";
import { parseGraphQLOperation, formatOperationLabel } from "../../core/graphqlOperation.js";

const body = (o: unknown) => JSON.stringify(o);

describe("parseGraphQLOperation", () => {
    it("uses an explicit operationName", () => {
        const r = parseGraphQLOperation(body({
            operationName: "GetCharacters",
            variables: { page: 1 },
            query: "query GetCharacters($page: Int!) { characters(page: $page) { id } }"
        }));
        expect(r).toEqual({ name: "GetCharacters", type: "query" });
    });

    it("parses a named query from the document when operationName is absent", () => {
        const r = parseGraphQLOperation(body({ query: "query GetUser { user { id } }" }));
        expect(r).toEqual({ name: "GetUser", type: "query" });
    });

    it("parses a named mutation and reports its type", () => {
        const r = parseGraphQLOperation(body({ query: "mutation CreatePost { createPost { id } }" }));
        expect(r).toEqual({ name: "CreatePost", type: "mutation" });
    });

    it("parses a subscription", () => {
        const r = parseGraphQLOperation(body({ query: "subscription OnTick { tick }" }));
        expect(r).toEqual({ name: "OnTick", type: "subscription" });
    });

    it("treats anonymous shorthand as an unnamed query", () => {
        const r = parseGraphQLOperation(body({ query: "{ user { id name } }" }));
        expect(r).toEqual({ name: null, type: "query" });
    });

    it("reports batch size for batched bodies and uses the first operation", () => {
        const r = parseGraphQLOperation(body([
            { query: "query A { a }" },
            { query: "query B { b }" },
            { query: "query C { c }" }
        ]));
        expect(r).toEqual({ name: "A", type: "query", batchSize: 3 });
    });

    it("handles an Apollo persisted query with no query field", () => {
        const r = parseGraphQLOperation(body({
            operationName: "GetCharacters",
            variables: {},
            extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } }
        }));
        expect(r).toEqual({ name: "GetCharacters", type: "query" });
    });

    // The guard that stops ordinary JSON POSTs being mislabeled as GraphQL.
    it("returns null for a non-GraphQL JSON body", () => {
        expect(parseGraphQLOperation(body({ email: "a@b.c", password: "x" }))).toBeNull();
    });

    it("returns null when a lookalike field is not a GraphQL document", () => {
        expect(parseGraphQLOperation(body({ query: 42 }))).toBeNull();
    });

    it("does not false-positive on the word mutation inside a field name", () => {
        const r = parseGraphQLOperation(body({ query: "{ mutationLog { id } }" }));
        expect(r).toEqual({ name: null, type: "query" });
    });

    it("returns null for malformed, empty and absent bodies", () => {
        expect(parseGraphQLOperation("{not json")).toBeNull();
        expect(parseGraphQLOperation("")).toBeNull();
        expect(parseGraphQLOperation(undefined)).toBeNull();
    });
});

describe("formatOperationLabel", () => {
    it("labels a named operation", () => {
        expect(formatOperationLabel({ name: "GetUser", type: "query" })).toBe("GetUser");
    });

    it("labels an anonymous operation by type", () => {
        expect(formatOperationLabel({ name: null, type: "mutation" })).toBe("anonymous mutation");
    });

    it("notes additional batched operations", () => {
        expect(formatOperationLabel({ name: "A", type: "query", batchSize: 3 })).toBe("A +2 more");
    });
});
