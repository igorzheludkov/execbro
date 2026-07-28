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

const payload = { generatedFrom: "toolRegistry", count: tools.length, tools };
writeFileSync(join(root, "tools.json"), `${JSON.stringify(payload, null, 4)}\n`, "utf8");
console.log(`wrote tools.json with ${tools.length} tools`);
