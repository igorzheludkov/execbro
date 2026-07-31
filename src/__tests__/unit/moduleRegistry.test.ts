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

    it("returns a descriptive error object when nothing matches", () => {
        const fakeR = Object.assign(() => undefined, { getModules: () => new Map([[1, { verboseName: "a/b.js" }]]) });
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({ __r: fakeR }) as (name: string) => { __eb_error?: string };
        const out = req("nope");
        expect(out.__eb_error).toContain("no module");
    });

    it("reports when the registry itself is unavailable", () => {
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({}) as (name: string) => { __eb_error?: string };
        expect(req("anything").__eb_error).toContain("Metro module registry");
    });

    it("reports separately when the registry exists but carries no names (minified bundle)", () => {
        const fakeR = Object.assign(() => undefined, { getModules: () => new Map([[1, {}]]) });
        const run = new Function("globalThis", buildRequireSource() + "; return __eb_require;");
        const req = run({ __r: fakeR }) as (name: string) => { __eb_error?: string };
        expect(req("anything").__eb_error).toContain("minified");
    });
});
