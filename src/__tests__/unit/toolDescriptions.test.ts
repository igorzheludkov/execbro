// Commit 6 of the MCP Tool Discoverability Rework — regression test that keeps
// every registered tool description above the bar set by Commits 2–5. Guards
// against silent regressions back to one-liners and against typos in WORKFLOW /
// SEE ALSO / PRIMARY / HELPER cross-references that would silently mislead
// agents to call tools that don't exist.
//
// See: docs/improvements/mcp-tool-discoverability-rework.md

// IMPORTANT: set test mode BEFORE importing src/index.ts so main() is skipped
// (no license check, no transport, no HTTP listener, no CDP sockets).
process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect } from "@jest/globals";
import { toolRegistry } from "../../index.js";

// Tools exempt from the "must contain PURPOSE or WHEN TO USE" and minimum-length
// checks. These are meta/account/admin tools where a short description reads
// naturally and adding a PURPOSE line would be boilerplate. execute_in_app uses
// semantically equivalent headings (RECOMMENDED WORKFLOW / LIMITATIONS / GOOD
// examples / BAD examples) instead of PURPOSE / WHEN TO USE — see plan.
const SEMANTIC_ALLOWLIST = new Set([
    "get_usage_guide",
    "activate_license",
    "get_license_status",
    "delete_account",
    "send_feedback",
    "reset_telemetry",
    "execute_in_app",
    "dev",
]);

// Non-tool identifiers that appear in descriptions (prop names, JS globals,
// schema keys, natural-language nouns that happen to match the tool-name
// regex). If the cross-reference scan hits one of these it's a false positive,
// not a broken link. Keep this list conservative — every addition weakens the
// guarantee, so prefer tightening the extractor over growing this set.
const NON_TOOL_TOKENS = new Set([
    // JS built-ins and common API shapes
    "true", "false", "null", "undefined", "console", "log", "error", "warn",
    "fetch", "require", "async", "await", "function", "return", "new",
    "typeof", "instanceof", "string", "number", "boolean", "object", "array",
    "map", "set", "promise", "date", "json", "regexp", "math",
    // Common param / prop names used in example tool calls
    "text", "query", "component", "pattern", "componentname", "testid",
    "x", "y", "verbose", "device", "deviceid", "udid", "packagename",
    "bundleid", "url", "uri", "method", "status", "level", "limit",
    "offset", "depth", "maxdepth", "timeout", "force", "forcerefresh",
    "healthcheck", "native", "strategy", "burst", "screenshot", "verify",
    "frameindex", "groupid", "id", "structureonly", "extended", "topic",
    "action", "tool", "args", "mode", "format", "type", "name", "value",
    "key", "keycode", "buttons", "headers", "body", "response", "request",
    "params", "args", "input", "output", "result", "data", "payload",
    // DSL / English verbs that match the regex in practice
    "e", "i", "s", "n", "t", "b", "a", "it", "is", "to", "of", "in", "on",
    "at", "by", "or", "and", "not", "use", "see", "call", "get", "set",
    "for", "via", "the", "its", "has", "all", "any", "ids", "file",
    // Schema / MCP things
    "isolated_vm", "isolated", "vm", "hermes", "jsc", "metro", "rn",
    "ios", "android", "cdp", "sdk", "ui", "ocr",
    // Verb-ish tokens used before "(" in English prose
    "returns", "includes", "uses", "uses_", "works", "tries", "prefers",
    "matches", "triggers", "scans", "parses", "reads", "writes", "sends",
    "sets", "gets", "checks", "detects", "enables", "disables", "skips",
    "supports", "handles", "captures", "adds", "removes", "runs", "is",
    "becomes", "executes", "fires", "emits", "wakes",
    "e.g", "i.e", "eg", "ie",
    // Connector words used in "prefer <word>" matches that aren't tool names
    "the", "this", "that", "these", "those",
    // Method-style identifiers appearing as examples
    "measureinwindow", "onpress", "onchangetext", "onfocus",
]);

describe("Tool descriptions (registration enforcement)", () => {
    const tools = Array.from(toolRegistry.entries()).map(([name, { config }]) => ({
        name,
        description: String(config?.description ?? ""),
    }));

    it("registers a non-trivial number of tools", () => {
        // Current count is ~60-70; a big drop would almost certainly be a bug.
        expect(tools.length).toBeGreaterThan(30);
    });

    describe("each tool has a rich description", () => {
        it.each(tools.map((t) => [t.name, t]))("%s", (_name, tool) => {
            const { name, description } = tool as { name: string; description: string };
            expect(description.length).toBeGreaterThan(0);
            expect(description.length).toBeLessThanOrEqual(1500);

            if (!SEMANTIC_ALLOWLIST.has(name)) {
                // Minimum length protects against regressions to one-liners.
                expect(description.length).toBeGreaterThanOrEqual(120);
                // Must contain a PURPOSE or WHEN TO USE anchor so the agent
                // can scan for intent before reading the whole description.
                const hasPurposeAnchor =
                    description.includes("PURPOSE") || description.includes("WHEN TO USE");
                expect(hasPurposeAnchor).toBe(true);
            }
        });
    });

    it("cross-references only point to registered tool names", () => {
        const registered = new Set(tools.map((t) => t.name));

        // Lines whose trailing content is a comma/space separated list of tool
        // names. These are the high-signal structured lines from the template.
        const ANCHOR_RE = /^(WORKFLOW|SEE ALSO|PRIMARY|HELPER|PLATFORM FALLBACK|PREFER|PREFERRED)\s*[:=-]/i;

        const unknown: Array<{ tool: string; token: string; line: string }> = [];

        for (const { name, description } of tools) {
            for (const rawLine of description.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!ANCHOR_RE.test(line)) continue;

                // Extract backtick-quoted identifiers and bare `name(` forms.
                const tokens = new Set<string>();
                for (const m of line.matchAll(/`([a-z_][a-z0-9_]+)`/gi)) tokens.add(m[1]);
                for (const m of line.matchAll(/([a-z_][a-z0-9_]+)\s*\(/gi)) tokens.add(m[1]);

                for (const token of tokens) {
                    const lower = token.toLowerCase();
                    if (registered.has(token)) continue;
                    if (NON_TOOL_TOKENS.has(lower)) continue;
                    // Heuristic: must look like a tool name (snake_case with an
                    // underscore or a known cross-platform primary). Single
                    // words like "prefer" are filtered out here.
                    if (!token.includes("_") && !registered.has(token)) {
                        // Could still be "tap" / "logbox" etc — only flag if
                        // it's also not a registered name.
                        if (!registered.has(token)) continue;
                    }
                    unknown.push({ tool: name, token, line });
                }
            }
        }

        if (unknown.length > 0) {
            const msg = unknown
                .map((u) => `  ${u.tool}: unknown "${u.token}" in "${u.line}"`)
                .join("\n");
            throw new Error(
                `Cross-reference check failed — the following tokens look like tool names in structured lines but are not registered:\n${msg}`
            );
        }
    });

    it("logs total tools/list payload size (informational)", () => {
        const totalBytes = tools
            .map((t) => JSON.stringify({ name: t.name, description: t.description }).length)
            .reduce((a, b) => a + b, 0);
        // eslint-disable-next-line no-console
        console.log(
            `[tool-descriptions] total tools/list payload: ${totalBytes} bytes across ${tools.length} tools`
        );
        // Sanity upper bound — not a strict cap, just to catch runaway growth.
        expect(totalBytes).toBeLessThan(500_000);
    });
});
