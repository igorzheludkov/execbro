#!/usr/bin/env node
/**
 * Fails the build when the published output mentions a third-party product.
 *
 * `files` ships build/, so anything in src/ reaches the npm tarball — including
 * internal notes. `removeComments` is NOT sufficient on its own: much of this
 * codebase builds injected JS inside template literals, and TypeScript passes
 * string content through verbatim, comments and all. A note written inside one
 * of those strings ships no matter what the compiler options say.
 *
 * This script checks the emitted output instead of the source, so it catches
 * every route in: real comments, injected-source comments, string literals and
 * tool descriptions alike.
 *
 * Lives in scripts/ deliberately — that directory is not published, so the
 * denylist itself never ships.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUILD_DIR = new URL("../build", import.meta.url).pathname;

/**
 * Products that must not appear in published output.
 *
 * Deliberately narrow. The rule being enforced is "do not describe a third
 * party's internals", not "never name a product" — naming Flipper or Chrome in
 * a tool description that explains which debuggers contend for the CDP slot is
 * legitimate and useful to the reader. This list is for products whose
 * behaviour has been inspected closely enough that any mention is likely to be
 * an internal note rather than user-facing copy.
 */
const DENYLIST = [
    "buoy"
];

function* walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            yield* walk(full);
        } else if (/\.(js|d\.ts|json)$/.test(entry)) {
            yield full;
        }
    }
}

const hits = [];
for (const file of walk(BUILD_DIR)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
        for (const term of DENYLIST) {
            if (line.toLowerCase().includes(term)) {
                hits.push(`${file.replace(BUILD_DIR, "build")}:${i + 1}  ${line.trim().slice(0, 120)}`);
            }
        }
    });
}

if (hits.length > 0) {
    console.error(
        `\nBuild hygiene check FAILED — published output names a third-party product ` +
        `(${hits.length} occurrence${hits.length === 1 ? "" : "s"}):\n`
    );
    for (const hit of hits.slice(0, 20)) console.error(`  ${hit}`);
    if (hits.length > 20) console.error(`  … and ${hits.length - 20} more`);
    console.error(
        `\nThis output is published to npm. Describe the behaviour or shape instead ` +
        `of naming the product, then rebuild.\n`
    );
    process.exit(1);
}

console.log(`build hygiene: clean (${DENYLIST.length} terms checked)`);
