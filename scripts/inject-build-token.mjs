#!/usr/bin/env node
// Publish-time injector. Rewrites the single "__BUILD_TOKEN__" placeholder in
// the compiled build output with the real secret from $BUILD_TOKEN. Run AFTER
// `npm run build` and BEFORE `npm publish`. Operates only on build output
// (gitignored), so the secret never enters source or git history.
//
// Fails loudly (non-zero exit) on any condition that would publish an
// unstamped or double-stamped build.
import { readFileSync, writeFileSync } from "node:fs";

const PLACEHOLDER = "__BUILD_TOKEN__";
// BUILD_TOKEN_TARGET overridable for tests; defaults to the compiled telemetry
// module where the placeholder literal lands. tsc emits a mirrored src/ tree
// (not a single bundle), so the placeholder lives in build/core/telemetry.js,
// not build/index.js.
const target =
    process.env.BUILD_TOKEN_TARGET ||
    new URL("../build/core/telemetry.js", import.meta.url).pathname;

const token = process.env.BUILD_TOKEN;
if (!token || token.trim() === "") {
    console.error(
        "inject-build-token: BUILD_TOKEN env var is missing or empty. Refusing to publish an unstamped build."
    );
    process.exit(1);
}

let src;
try {
    src = readFileSync(target, "utf-8");
} catch (e) {
    console.error(`inject-build-token: cannot read ${target}: ${e.message}`);
    process.exit(1);
}

const occurrences = src.split(PLACEHOLDER).length - 1;
if (occurrences === 0) {
    console.error(
        `inject-build-token: placeholder ${PLACEHOLDER} not found in ${target}. ` +
            "Run `npm run build` first; the build may be stale or already injected."
    );
    process.exit(1);
}
if (occurrences > 1) {
    console.error(
        `inject-build-token: placeholder ${PLACEHOLDER} found ${occurrences} times; expected exactly once.`
    );
    process.exit(1);
}

writeFileSync(target, src.replace(PLACEHOLDER, token));
console.error(`inject-build-token: injected build token into ${target}`);
