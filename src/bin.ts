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

await import("./index.js");
