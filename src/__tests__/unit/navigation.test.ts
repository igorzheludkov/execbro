import { describe, it, expect } from "@jest/globals";
import { buildNavHandlesSource } from "../../core/navigation.js";

describe("buildNavHandlesSource", () => {
    const source = buildNavHandlesSource();

    function resolveWith(globalStub: Record<string, unknown>) {
        const run = new Function("globalThis", source + "; return __eb_nav;");
        return run(globalStub) as { navigator: unknown; stateReader: unknown; kind: string | null; note: string | null };
    }

    const expoRouter = {
        navigate: () => undefined,
        push: () => undefined,
        replace: () => undefined,
        back: () => undefined,
        dismiss: () => undefined,
        dismissAll: () => undefined,
        canDismiss: () => true,
        prefetch: () => undefined,
        setParams: () => undefined
    };
    const rnRootRef = {
        navigate: () => undefined,
        goBack: () => undefined,
        reset: () => undefined,
        resetRoot: () => undefined,
        dispatch: () => undefined,
        getRootState: () => ({ routes: [], index: 0 }),
        getCurrentRoute: () => ({ name: "Home" }),
        getState: () => ({ routes: [], index: 0 })
    };

    it("emits Hermes-compatible ES5 only", () => {
        expect(source).not.toMatch(/\bconst\b|\blet\b/);
        expect(source).not.toMatch(/=>/);
        expect(source).not.toMatch(/\basync\b/);
        expect(source).not.toContain("`");
    });

    it("returns all-null when nothing resolves", () => {
        const out = resolveWith({});
        expect(out.navigator).toBeNull();
        expect(out.stateReader).toBeNull();
        expect(out.kind).toBeNull();
        expect(String(out.note)).toContain("No router");
    });

    it("classifies a React Navigation root ref by resetRoot", () => {
        const out = resolveWith({ __EB_TEST_FIBER_NAV__: rnRootRef });
        expect(out.kind).toBe("react-navigation");
        expect(out.navigator).toBe(rnRootRef);
        expect(out.stateReader).toBe(rnRootRef);
    });

    it("classifies Expo Router by dismiss and pairs it with a fiber state reader", () => {
        const out = resolveWith({
            __EB_TEST_MODULE_ROUTER__: expoRouter,
            __EB_TEST_FIBER_NAV__: rnRootRef
        });
        expect(out.kind).toBe("expo-router");
        expect(out.navigator).toBe(expoRouter);
        // Expo Router has no getRootState — state must come from the fiber ref.
        expect(out.stateReader).toBe(rnRootRef);
    });

    it("notes when Expo Router resolved without a state reader", () => {
        const out = resolveWith({ __EB_TEST_MODULE_ROUTER__: expoRouter });
        expect(out.kind).toBe("expo-router");
        expect(out.stateReader).toBeNull();
        expect(String(out.note)).toContain("route state");
    });

    it("prefers the library module over an app-exposed global wrapper", () => {
        // AppB's __EXPO_ROUTER__ is a hand-built wrapper carrying its own
        // {router, currentPath, segments, ...}, not the library's router.
        const wrapper = { router: expoRouter, navigate: () => undefined, currentPath: "/" };
        const out = resolveWith({ __EB_TEST_MODULE_ROUTER__: expoRouter, __EXPO_ROUTER__: wrapper });
        expect(out.navigator).toBe(expoRouter);
    });
});
