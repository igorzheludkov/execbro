import { readFileSync } from "fs";
import { join } from "path";

// Jest runs from the package root (jest.config roots: <rootDir>/src), and the
// suite is pure ESM (ts-jest default-esm preset) where __dirname is undefined,
// so resolve the source file from process.cwd() instead.
const TELEMETRY_SRC = join(process.cwd(), "src", "core", "telemetry.ts");

// The build token placeholder must exist verbatim in source so the
// publish-time injector can find and replace it. A source checkout
// (any fork) keeps this literal, which the server treats as a fork.
describe("BUILD_TOKEN placeholder", () => {
    it("ships the literal __BUILD_TOKEN__ placeholder in telemetry source", () => {
        const src = readFileSync(TELEMETRY_SRC, "utf-8");
        expect(src.includes('"__BUILD_TOKEN__"')).toBe(true);
    });
});

describe("telemetry payload wiring", () => {
    it("dispatch() includes buildToken built from the BUILD_TOKEN constant", () => {
        const src = readFileSync(TELEMETRY_SRC, "utf-8");
        expect(src.includes("buildToken: BUILD_TOKEN")).toBe(true);
    });
});
