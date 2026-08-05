import { describe, it, expect } from "@jest/globals";
import { buildNetInfoPatchScript, parseNetInfoResult } from "../../core/netInfoPatch.js";

describe("buildNetInfoPatchScript", () => {
    it("embeds the module-registry require helper", () => {
        expect(buildNetInfoPatchScript(true)).toContain("__eb_require");
    });

    it("registers a probe subscriber BEFORE emitting, so the result is measured not assumed", () => {
        const s = buildNetInfoPatchScript(true);
        expect(s.indexOf("addEventListener")).toBeLessThan(s.indexOf("RCTDeviceEventEmitter"));
    });

    it("reports one of the three defined outcomes", () => {
        const s = buildNetInfoPatchScript(true);
        expect(s).toContain("not-installed");
        expect(s).toContain("reads-patched-only");
        expect(s).toContain("patched");
    });

    it("is ES5 — no let/const/arrow/template literals", () => {
        const s = buildNetInfoPatchScript(true);
        expect(s).not.toMatch(/\blet\s/);
        expect(s).not.toMatch(/\bconst\s/);
        expect(s).not.toMatch(/=>/);
        expect(s).not.toContain("`");
    });

    it("carries the opposite connectivity state for offline and online", () => {
        expect(buildNetInfoPatchScript(true)).toContain("isConnected: false");
        expect(buildNetInfoPatchScript(false)).toContain("isConnected: true");
    });

    it("restores the real fetch when going back online", () => {
        // A one-way patch would leave NetInfo permanently lying after
        // network_condition({mode:"normal"}).
        expect(buildNetInfoPatchScript(false)).toContain("__eb_realFetch");
    });
});

describe("parseNetInfoResult", () => {
    it("reads the outcome out of the evaluated JSON", () => {
        expect(parseNetInfoResult('{"netInfo":"patched"}')).toBe("patched");
        expect(parseNetInfoResult('{"netInfo":"reads-patched-only"}')).toBe("reads-patched-only");
    });

    it("treats anything unparseable as unknown rather than claiming success", () => {
        expect(parseNetInfoResult("undefined")).toBe("unknown");
        expect(parseNetInfoResult("")).toBe("unknown");
        expect(parseNetInfoResult('{"netInfo":"something-else"}')).toBe("unknown");
    });

    it("survives the result arriving as an already-quoted JSON string", () => {
        // Runtime.evaluate returns the expression's value; depending on the
        // path it can arrive double-encoded.
        expect(parseNetInfoResult('"{\\"netInfo\\":\\"not-installed\\"}"')).toBe("not-installed");
    });
});
