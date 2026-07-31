import { describe, it, expect } from "@jest/globals";
import { buildContextPreamble, CONTEXT_BINDINGS } from "../../core/appContext.js";

describe("buildContextPreamble", () => {
    const source = buildContextPreamble();

    function evaluateWith(globalStub: Record<string, unknown>, expr: string): unknown {
        const run = new Function("globalThis", source + "; return (" + expr + ");");
        return run(globalStub);
    }

    it("emits Hermes-compatible ES5 only", () => {
        expect(source).not.toMatch(/\bconst\b|\blet\b/);
        expect(source).not.toMatch(/=>/);
        expect(source).not.toMatch(/\basync\b/);
        expect(source).not.toContain("`");
    });

    it("declares every advertised binding", () => {
        for (const name of CONTEXT_BINDINGS) {
            expect(source).toContain(name);
        }
    });

    it("defers the expensive bindings behind functions", () => {
        // cache() must not run extract() at preamble time — it costs 17ms and
        // can materialise 1.6MB.
        expect(source).toMatch(/function cache\(/);
    });

    it("resolves everything to null when nothing is available", () => {
        const out = evaluateWith({}, "{ store: store, state: state, router: router, apollo: apollo }") as Record<string, unknown>;
        expect(out.store).toBeNull();
        expect(out.state).toBeNull();
        expect(out.router).toBeNull();
        expect(out.apollo).toBeNull();
    });

    it("resolves a redux store from a known global when the fiber walk finds nothing", () => {
        const store = {
            getState: () => ({ auth: { id: 1 } }),
            dispatch: () => undefined,
            subscribe: () => undefined
        };
        const out = evaluateWith({ __REDUX_STORE__: store }, "{ store: store, state: state }") as {
            store: unknown;
            state: { auth: { id: number } };
        };
        expect(out.store).toBe(store);
        expect(out.state.auth.id).toBe(1);
    });

    it("falls back to the SDK store registry", () => {
        const store = { getState: () => ({ ok: true }), dispatch: () => undefined, subscribe: () => undefined };
        const out = evaluateWith(
            { __RN_AI_DEVTOOLS__: { stores: { redux: store } } },
            "{ store: store, state: state }"
        ) as { store: unknown; state: { ok: boolean } };
        expect(out.store).toBe(store);
        expect(out.state.ok).toBe(true);
    });

    it("derefs an Apollo normalized reference and passes plain values through", () => {
        const cacheObj = { "Entity:1": { id: "1", name: "Acme" } };
        const deref = evaluateWith({}, "deref") as (x: unknown, c: unknown) => unknown;
        expect(deref({ __ref: "Entity:1" }, cacheObj)).toEqual({ id: "1", name: "Acme" });
        expect(deref({ plain: true }, cacheObj)).toEqual({ plain: true });
        expect(deref(null, cacheObj)).toBeNull();
    });

    it("summary reports per-key type and byte size, heaviest first", () => {
        const summary = evaluateWith({}, "summary") as (v: unknown) => Array<Record<string, unknown>>;
        const rows = summary({ small: { a: 1 }, big: { pad: "x".repeat(500) } });
        expect(rows[0].key).toBe("big");
        expect(rows[0].type).toBe("object");
        expect(rows[0].bytes as number).toBeGreaterThan(rows[1].bytes as number);
    });

    it("summary survives a non-serialisable value instead of throwing", () => {
        const summary = evaluateWith({}, "summary") as (v: unknown) => Array<Record<string, unknown>>;
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const rows = summary({ cyclic, fine: 1 });
        expect(rows.find((r) => r.key === "cyclic")?.bytes).toBe(-1);
    });
});
