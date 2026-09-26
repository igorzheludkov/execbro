import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const HELPER = join("core", "injected", "fiberRoots.ts");

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p);
        return p.endsWith(".ts") ? [p] : [];
    });
}

describe("fiber-root lookup has one home", () => {
    it("no source file outside injected/fiberRoots.ts calls getFiberRoots(", () => {
        const offenders = walk(SRC)
            .filter((p) => relative(SRC, p) !== HELPER)
            .filter((p) => /getFiberRoots\s*(\?\.)?\(/.test(readFileSync(p, "utf8")))
            .map((p) => relative(SRC, p));
        expect(offenders).toEqual([]);
    });
});
