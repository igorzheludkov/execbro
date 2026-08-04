import { readFileSync } from "fs";
import { join } from "path";

import { isPublishedBuild } from "../../core/buildInfo.js";

// Jest runs from the package root (jest.config roots: <rootDir>/src), and the
// suite is pure ESM (ts-jest default-esm preset) where __dirname is undefined,
// so resolve the source files from process.cwd() instead.
const BUILD_INFO_SRC = join(process.cwd(), "src", "core", "buildInfo.ts");
const TELEMETRY_SRC = join(process.cwd(), "src", "core", "telemetry.ts");

// Split so this file does not itself contain the literal the injector hunts for.
const PLACEHOLDER = "__BUILD" + "_TOKEN__";

// The build token placeholder must exist verbatim in source so the
// publish-time injector can find and replace it. A source checkout
// (any fork) keeps this literal, which the server treats as a fork.
describe("BUILD_TOKEN placeholder", () => {
    it("ships the literal placeholder in the build-info source", () => {
        const src = readFileSync(BUILD_INFO_SRC, "utf-8");
        expect(src.includes(`"${PLACEHOLDER}"`)).toBe(true);
    });

    // scripts/inject-build-token.mjs refuses to publish unless the compiled
    // module contains the placeholder exactly once. A second occurrence would
    // also mean isPublishedBuild()'s comparison value gets rewritten alongside
    // the constant, silently disabling the --http gate in published builds.
    it("contains the placeholder exactly once", () => {
        const src = readFileSync(BUILD_INFO_SRC, "utf-8");
        expect(src.split(PLACEHOLDER).length - 1).toBe(1);
    });
});

describe("telemetry payload wiring", () => {
    it("dispatch() includes buildToken built from the BUILD_TOKEN constant", () => {
        const src = readFileSync(TELEMETRY_SRC, "utf-8");
        expect(src.includes("buildToken: BUILD_TOKEN")).toBe(true);
    });

    it("imports the token rather than redeclaring the placeholder", () => {
        const src = readFileSync(TELEMETRY_SRC, "utf-8");
        expect(src.includes('from "./buildInfo.js"')).toBe(true);
        expect(src.includes(PLACEHOLDER)).toBe(false);
    });
});

describe("isPublishedBuild", () => {
    it("reports a source checkout as unpublished", () => {
        expect(isPublishedBuild()).toBe(false);
    });
});
