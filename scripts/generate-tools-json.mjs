// Emits tools.json — the canonical list of registered MCP tools, for consumers
// that need the tool surface without importing this package. The website's
// /readme/tools reference vendors it and validates its own catalogue against
// it, so a tool added or removed here fails the docs build until documented.
//
// RN_AI_DEVTOOLS_TEST_MODE skips main(): no license check, no transport, no CDP
// sockets. Tools still register, which is the whole point.
process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { toolRegistry } = await import(join(root, "build/index.js"));

const tools = [...toolRegistry.keys()].sort();
if (tools.length === 0) throw new Error("toolRegistry is empty — is build/ stale? Run `npm run build` first.");

// Parameter names per tool, so consumers can assert their prose does not
// reference a parameter that no longer exists. Tool ADD/REMOVE was already
// caught by the name list; parameter changes drifted silently — four website
// entries advertised a removed `format` parameter for months while every test
// stayed green. `inputSchema` is a raw Zod shape, so its keys are the names.
const params = {};
for (const name of tools) {
    const shape = toolRegistry.get(name)?.config?.inputSchema;
    if (!shape) throw new Error(`${name} has no inputSchema — cannot record its parameters`);
    params[name] = Object.keys(shape).sort();
}

const payload = {
    generatedFrom: "toolRegistry",
    count: tools.length,
    tools,
    // Kept as a separate map rather than folded into `tools` so existing
    // consumers reading `tools` as a string array keep working.
    params,
};
writeFileSync(join(root, "tools.json"), `${JSON.stringify(payload, null, 4)}\n`, "utf8");
const paramCount = Object.values(params).reduce((n, p) => n + p.length, 0);
console.log(`wrote tools.json with ${tools.length} tools and ${paramCount} parameters`);
