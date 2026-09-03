#!/usr/bin/env node
/**
 * Fails the build when injected JavaScript inside a template literal contains an
 * escape sequence that the template literal will eat.
 *
 * Much of this codebase authors JavaScript for the app's Hermes runtime inside
 * backtick strings. Those strings are parsed twice: once by TypeScript as a
 * template literal, and once by Hermes as source. TypeScript resolves escape
 * sequences during the first pass, so `\d` in the source arrives as a bare `d`
 * on the device — the regex still parses, still matches, and now means something
 * different. That is why the existing injected sources are written `\\d`.
 *
 * The failure has no symptom at build time and no error at runtime. It shows up
 * as a screen read that quietly stops matching something, which is the most
 * expensive kind of bug this project has.
 *
 * Deliberately NOT checked here:
 *   - a stray backtick inside injected JS. It terminates the template literal, so
 *     tsc already rejects it. The message points at the wrong place, but the
 *     build does fail, and a second check would only duplicate it.
 *   - `${` inside injected JS. There is no way to tell an accidental
 *     interpolation from an intended one, and the intended ones are everywhere.
 *
 * Runs on src/, not build/: by the time TypeScript has emitted, the evidence is
 * gone — an eaten escape and a correctly written character are the same bytes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
const REPO_DIR = new URL("..", import.meta.url).pathname;

/**
 * Escapes that mean something to a regular expression and nothing to a string.
 *
 * Excluded on purpose: n t r v f 0 x u \ ' " ` $ and newline, every one of which
 * is a legitimate string escape that an author may well have meant. `b` is in the
 * list even though \b is a valid string escape (backspace), because inside
 * injected source it is a word boundary far more often than it is a control
 * character — and writing \\b when you meant backspace is harmless.
 */
const EATEN = "dDwWsSbB.+*?^$|/()[]{}-";

/**
 * Walk a TypeScript source and report escape sequences that sit inside a template
 * literal and will not survive it.
 *
 * Tracks enough syntax to know where a template literal starts and stops: quoted
 * strings, line and block comments, and `${...}` interpolations, which return to
 * ordinary code and must not be scanned. Regex literals are not tracked — the
 * cost of getting that wrong is a false positive on a regex containing a backtick,
 * which does not occur in this codebase.
 */
export function findEatenEscapes(source) {
    const findings = [];
    let i = 0;
    let line = 1;
    // Depth of nested template literals; each `${}` inside one pushes back to code.
    const stack = [];
    let inTemplate = false;
    let interpolationDepth = 0;

    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];

        if (c === "\n") { line++; i++; continue; }

        if (!inTemplate) {
            if (c === "/" && next === "/") {
                while (i < source.length && source[i] !== "\n") i++;
                continue;
            }
            if (c === "/" && next === "*") {
                i += 2;
                while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
                    if (source[i] === "\n") line++;
                    i++;
                }
                i += 2;
                continue;
            }
            if (c === '"' || c === "'") {
                const quote = c;
                i++;
                while (i < source.length && source[i] !== quote) {
                    if (source[i] === "\\") i++;
                    if (source[i] === "\n") line++;
                    i++;
                }
                i++;
                continue;
            }
            if (c === "`") {
                inTemplate = true;
                stack.push(interpolationDepth);
                interpolationDepth = 0;
                i++;
                continue;
            }
            if (c === "}" && stack.length > 0 && interpolationDepth === 0) {
                // Closing a `${` — back inside the template that opened it.
                inTemplate = true;
                i++;
                continue;
            }
            if (c === "{") interpolationDepth++;
            else if (c === "}") interpolationDepth--;
            i++;
            continue;
        }

        // Inside a template literal.
        if (c === "\\") {
            const escaped = next;
            if (escaped === "\n") { line++; i += 2; continue; }
            if (escaped === "\\") { i += 2; continue; }
            if (escaped !== undefined && EATEN.indexOf(escaped) !== -1) {
                findings.push({ line, sequence: "\\" + escaped });
            }
            i += 2;
            continue;
        }
        if (c === "$" && next === "{") {
            inTemplate = false;
            interpolationDepth = 0;
            i += 2;
            continue;
        }
        if (c === "`") {
            inTemplate = false;
            interpolationDepth = stack.pop() ?? 0;
            i++;
            continue;
        }
        i++;
    }
    return findings;
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === "__tests__" || entry === "node_modules") continue;
            yield* walk(full);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
            yield full;
        }
    }
}

function main() {
    const problems = [];
    let scanned = 0;
    for (const file of walk(SRC_DIR)) {
        scanned++;
        for (const f of findEatenEscapes(readFileSync(file, "utf8"))) {
            problems.push(`${relative(REPO_DIR, file)}:${f.line}  ${f.sequence}`);
        }
    }

    if (problems.length > 0) {
        console.error(
            `injected JS: ${problems.length} escape sequence(s) inside a template literal will not reach the device.\n` +
            `A template literal resolves these before Hermes ever sees them, so \\d arrives as d and the\n` +
            `regex silently changes meaning. Double the backslash (\\\\d) to pass it through.\n`
        );
        for (const p of problems) console.error(`  ${p}`);
        process.exit(1);
    }
    console.log(`injected JS: clean (${scanned} files scanned)`);
}

if (process.argv[1] && process.argv[1].endsWith("check-injected-js.mjs")) main();
