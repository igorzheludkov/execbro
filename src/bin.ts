#!/usr/bin/env node
/**
 * Executable entry point. Exists solely to turn on Node's source-map support
 * BEFORE any application module is compiled, then hand off to the real server.
 *
 * Why a separate file instead of a line at the top of index.ts: ESM hoists
 * static imports, so every module in the graph is compiled before the first
 * statement of index.ts runs — and Node only attaches source-map data to
 * modules compiled while the flag is on. Enabling it inside index.ts is a
 * silent no-op (verified: frames still resolved to build/*.js). The dynamic
 * import below is what makes the ordering correct.
 *
 * Why not `#!/usr/bin/env -S node --enable-source-maps`: busybox env (Alpine)
 * has no -S, and a shebang that fails to parse means the CLI cannot start at
 * all. This costs one extra module load and works everywhere.
 *
 * Payoff: posthog-node reports stack frames verbatim from Node, so error
 * tracking gets src/**\/*.ts file+line instead of compiled build/*.js offsets.
 */
process.setSourceMapsEnabled(true);

// Answered here, before the server module loads: `execbro --help` used to
// start the MCP server and sit waiting on stdin, which is what an agent told to
// try `<tool> --help` saw in the 2026-10 benchmark.
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v")) {
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    if (args.includes("--version") || args.includes("-v")) {
        console.log(version);
    } else {
        console.log(`execbro ${version}: MCP server that gives AI agents runtime access to React Native, Electron and native Android apps.

Usage:
  execbro                 Start the MCP server on stdio. MCP clients launch it this way; there is nothing to run by hand.
  execbro --help, -h      Show this help.
  execbro --version, -v   Print the version.

Add it to Claude Code:
  claude mcp add execbro --scope project -- npx -y execbro@latest

Docs: https://github.com/igorzheludkov/execbro#readme`);
    }
    process.exit(0);
}

await import("./index.js");
