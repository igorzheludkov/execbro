import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../inject-build-token.mjs", import.meta.url).pathname;

function run(env, fileContents) {
    const dir = mkdtempSync(join(tmpdir(), "inj-"));
    const target = join(dir, "index.js");
    if (fileContents !== null) writeFileSync(target, fileContents);
    try {
        execFileSync("node", [SCRIPT], {
            env: { ...process.env, ...env, BUILD_TOKEN_TARGET: target },
            stdio: "pipe",
        });
        return { ok: true, target, dir };
    } catch (e) {
        return { ok: false, target, dir, stderr: String(e.stderr || e.message) };
    }
}

test("replaces the placeholder with the env token", () => {
    const r = run(
        { BUILD_TOKEN: "s3cr3t-abc" },
        'const BUILD_TOKEN = "__BUILD_TOKEN__";'
    );
    assert.ok(r.ok, "script should succeed");
    const out = readFileSync(r.target, "utf-8");
    assert.ok(out.includes('"s3cr3t-abc"'));
    assert.ok(!out.includes("__BUILD_TOKEN__"));
    rmSync(r.dir, { recursive: true, force: true });
});

test("fails when BUILD_TOKEN env is missing", () => {
    const r = run({ BUILD_TOKEN: "" }, 'const x = "__BUILD_TOKEN__";');
    assert.equal(r.ok, false);
    assert.ok(/BUILD_TOKEN/.test(r.stderr));
    rmSync(r.dir, { recursive: true, force: true });
});

test("fails when placeholder is absent (already injected / stale build)", () => {
    const r = run({ BUILD_TOKEN: "tok" }, 'const x = "already-real";');
    assert.equal(r.ok, false);
    assert.ok(/placeholder/i.test(r.stderr));
    rmSync(r.dir, { recursive: true, force: true });
});

test("fails when placeholder appears more than once", () => {
    const r = run(
        { BUILD_TOKEN: "tok" },
        'a="__BUILD_TOKEN__"; b="__BUILD_TOKEN__";'
    );
    assert.equal(r.ok, false);
    assert.ok(/once|multiple|more than/i.test(r.stderr));
    rmSync(r.dir, { recursive: true, force: true });
});
