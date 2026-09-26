import { describe, it, expect } from "@jest/globals";
import vm from "node:vm";
import { buildContextPreamble } from "../../core/appContext.js";

// A top-level `var` in an evaluated script is a property of the global object.
// Harmless in Hermes, which has no global `require`, but in a browser page
// (Electron with nodeIntegration, AMD loaders) it silently replaced the app's own.
describe("context preamble on a page that already has require", () => {
    it("leaves the page's global require untouched", () => {
        const pageRequire = () => "page";
        const sandbox: Record<string, unknown> = { require: pageRequire };
        vm.runInNewContext(buildContextPreamble(), sandbox);
        expect(sandbox.require).toBe(pageRequire);
    });

    it("still provides require where the runtime has none (Hermes)", () => {
        const sandbox: Record<string, unknown> = {};
        vm.runInNewContext(buildContextPreamble(), sandbox);
        expect(typeof sandbox.require).toBe("function");
    });

    it("refreshes its own require on every call, so the module index is never stale", () => {
        const sandbox: Record<string, unknown> = {};
        vm.runInNewContext(buildContextPreamble(), sandbox);
        const first = sandbox.require;
        vm.runInNewContext(buildContextPreamble(), sandbox);
        expect(sandbox.require).not.toBe(first);
        expect(sandbox.require).toBe(sandbox.__eb_require);
    });
});
