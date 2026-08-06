import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OLD_SDK = ["react-native", "ai-devtools", "sdk"].join("-");
const OLD_REPO = ["igorzheludkov/react-native", "ai-devtools"].join("-");

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            // The test suite quotes the old names on purpose; src/pro/LICENSE is legal text.
            return entry === "__tests__" || entry === "pro" ? [] : sourceFiles(path);
        }
        return path.endsWith(".ts") ? [path] : [];
    });
}

const hits = sourceFiles(SRC).flatMap((path) =>
    readFileSync(path, "utf-8")
        .split("\n")
        .map((line, i) => ({ path, line: i + 1, text: line }))
        .filter((entry) => entry.text.includes(OLD_SDK) || entry.text.includes(OLD_REPO))
);

describe("pre-rename names do not leak into shipped strings", () => {
    // Guard the guard: a scanner that reads nothing would pass both assertions below.
    it("actually scans source (the surviving 'formerly' mentions are found)", () => {
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.text.includes("formerly"))).toBe(true);
    });

    it("names no repo slug from before the execbro rename", () => {
        const repoHits = hits.filter((h) => h.text.includes(OLD_REPO));
        expect(repoHits.map((h) => `${h.path}:${h.line}`)).toEqual([]);
    });

    it("names the SDK package only as a 'formerly' aid to recognition", () => {
        const bare = hits.filter((h) => h.text.includes(OLD_SDK) && !h.text.includes("formerly"));
        expect(bare.map((h) => `${h.path}:${h.line}`)).toEqual([]);
    });
});
