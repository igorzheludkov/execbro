// Guards the get_logs empty-result contract at the source level.
//
// The original bug was not bad logic — it was a return path that forgot to
// report. Every `get_logs` exit must set `_emptyResult`. Removing the TONL
// format halved the exits (each format branch was a duplicated return);
// this test pins the remaining count so a new silent path is noticed.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src/tools/logTools.ts"), "utf8");

/** Slice out just the get_logs registration (up to where search_logs begins). */
function getLogsHandlerSource(): string {
    const start = SOURCE.indexOf('"get_logs"');
    const end = SOURCE.indexOf('"search_logs"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
}

/**
 * The handler body only — excludes the trailing `emptyResultDetector` argument,
 * which is a deliberate last-resort fallback and is allowed to consult the
 * global buffer count.
 */
function getLogsBodySource(): string {
    const src = getLogsHandlerSource();
    const detectorAt = src.indexOf("// Fallback only");
    expect(detectorAt).toBeGreaterThan(-1);
    return src.slice(0, detectorAt);
}

/**
 * Find every `return { ... }` object literal that carries a `content:` key —
 * i.e. every actual tool response. Brace-matched rather than regex-matched so
 * nested objects inside the literal don't truncate the match.
 */
function toolResponseReturns(src: string): string[] {
    const found: string[] = [];
    const marker = /return\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(src)) !== null) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < src.length; i++) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") {
                depth--;
                if (depth === 0) break;
            }
        }
        const literal = src.slice(m.index, i + 1);
        if (literal.includes("content:")) found.push(literal);
    }
    return found;
}

describe("get_logs empty-result contract", () => {
    const returns = toolResponseReturns(getLogsHandlerSource());

    it("finds every tool response return path", () => {
        // SDK summary, SDK entries, buffer summary, recovered retry, final.
        expect(returns.length).toBe(5);
    });

    it("reports _emptyResult on every return path", () => {
        const missing = returns.filter(r => !r.includes("_emptyResult"));
        expect(missing).toEqual([]);
    });

    it("never re-derives emptiness from the global buffer count inline", () => {
        // getTotalLogCount() spans all devices and ignores level/text filters,
        // so it must not decide what a single filtered read reports.
        const handler = getLogsBodySource();
        expect(handler).not.toContain("getTotalLogCount() === 0");
    });

    it("routes every empty-path diagnosis through diagnoseEmptyLogs", () => {
        const handler = getLogsBodySource();
        // Connection/pipeline verdicts belong to the shared diagnosis module —
        // the handler must never hand-roll them, or the two drift apart.
        // `filtered_out` is deliberately handler-local: it is a statement about
        // the caller's level/text filter, not about connection state.
        const diagnosisOwned = [
            "disconnected",
            "post_reconnect",
            "pipeline_failed",
            "pipeline_recovered",
            "no_logs_verified",
            "no_logs_unverified"
        ];
        for (const reason of diagnosisOwned) {
            expect(handler).not.toMatch(new RegExp(`emptyReason\\s*=\\s*"${reason}"`));
        }
        expect(handler.match(/diagnoseEmptyLogs\(/g)?.length).toBe(2);
    });

    it("does not emit the ambiguous legacy no_logs label", () => {
        expect(getLogsBodySource()).not.toMatch(/"no_logs"/);
    });
});
