import { describe, it, expect } from "@jest/globals";
import { buildRequireSource } from "../../core/moduleRegistry.js";

describe("buildRequireSource", () => {
    const source = buildRequireSource();

    it("emits Hermes-compatible ES5 only", () => {
        expect(source).not.toMatch(/\bconst\b|\blet\b/);
        expect(source).not.toMatch(/=>/);
        expect(source).not.toMatch(/\basync\b/);
        expect(source).not.toContain("`");
    });

    it("defines the require helper under a namespaced name", () => {
        expect(source).toContain("__eb_require");
    });

    it("evaluates to a working resolver against a fake Metro registry", () => {
        const modules = new Map<number, { verboseName?: string }>([
            [1, { verboseName: "node_modules/react-native/index.js" }],
            [1017, { verboseName: "node_modules/expo-router/build/imperative-api.js" }],
            [42, { verboseName: "src/app/store/index.ts" }]
        ]);
        const loaded: Record<number, unknown> = {
            1: { Dimensions: { get: () => ({ width: 390 }) } },
            1017: { router: { navigate: () => "ok" } },
            42: { store: { getState: () => ({}) } }
        };
        const fakeR = Object.assign((id: number) => loaded[id], { getModules: () => modules });
        const globalThisStub: Record<string, unknown> = { __r: fakeR };

        const run = new Function("globalThis", source + "; return __eb_require;");
        const req = run(globalThisStub) as (name: string) => unknown;

        expect((req("expo-router") as { router: unknown }).router).toBeDefined();
        expect(req("store/index")).toBeDefined();
    });

    it("prefers the shortest matching path so a package name lands on its entry", () => {
        const modules = new Map<number, { verboseName?: string }>([
            [5, { verboseName: "node_modules/expo-router/build/internal/deep/nested/helper.js" }],
            [6, { verboseName: "node_modules/expo-router/build/index.js" }]
        ]);
        const loaded: Record<number, unknown> = { 5: { helper: true }, 6: { entry: true } };
        const fakeR = Object.assign((id: number) => loaded[id], { getModules: () => modules });

        const run = new Function("globalThis", source + "; return __eb_require;");
        const req = run({ __r: fakeR }) as (name: string) => Record<string, unknown>;
        expect(req("expo-router").entry).toBe(true);
    });

    it("throws a descriptive error when nothing matches", () => {
        const fakeR = Object.assign(() => undefined, { getModules: () => new Map([[1, { verboseName: "a/b.js" }]]) });
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({ __r: fakeR }) as (name: string) => unknown;
        expect(() => req("nope")).toThrow(/no module/);
    });

    it("throws when the registry itself is unavailable", () => {
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({}) as (name: string) => unknown;
        expect(() => req("anything")).toThrow(/Metro module registry/);
    });

    it("throws separately when the registry exists but carries no names (minified bundle)", () => {
        const fakeR = Object.assign(() => undefined, { getModules: () => new Map([[1, {}]]) });
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({ __r: fakeR }) as (name: string) => unknown;
        expect(() => req("anything")).toThrow(/minified/);
    });

    it("throws when the module fails to evaluate", () => {
        const fakeR = Object.assign(() => { throw new Error("boom"); }, { getModules: () => new Map([[1, { verboseName: "src/a.ts" }]]) });
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({ __r: fakeR }) as (name: string) => unknown;
        expect(() => req("src/a")).toThrow(/failed to evaluate: boom/);
    });

    describe("app paths (Opus benchmark: require('./src/shop/authSlice') returned an error object)", () => {
        const modules = new Map<number, { verboseName?: string }>([
            [1, { verboseName: "node_modules/react-native/index.js" }],
            [7, { verboseName: "src/shop/authSlice.ts" }],
            [8, { verboseName: "src/shop/cart/index.ts" }]
        ]);
        const loaded: Record<number, unknown> = { 1: { rn: true }, 7: { signIn: "fn" }, 8: { cart: true } };
        const fakeR = Object.assign((id: number) => loaded[id], { getModules: () => modules });
        const req = new Function("globalThis", buildRequireSource() + "; return __eb_require;")({ __r: fakeR }) as (name: string) => Record<string, unknown>;

        it("resolves a ./ relative path without extension", () => {
            expect(req("./src/shop/authSlice").signIn).toBe("fn");
            expect(req("src/shop/authSlice").signIn).toBe("fn");
            expect(req("./src/shop/cart").cart).toBe(true);
        });

        it("throws a readable error on a miss", () => {
            expect(() => req("./src/shop/nope")).toThrow(/no module matching "src\/shop\/nope"/);
        });

        it("names near misses", () => {
            expect(() => req("./src/shop/authslice")).toThrow(/src\/shop\/authSlice\.ts/);
        });
    });
});
