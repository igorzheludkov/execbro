import type { Config } from "jest";

const config: Config = {
    preset: "ts-jest/presets/default-esm",
    testEnvironment: "node",
    roots: ["<rootDir>/src"],
    testMatch: ["**/__tests__/**/*.test.ts"],
    setupFilesAfterEnv: ["./src/__tests__/setup.ts"],
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            {
                useESM: true,
                diagnostics: {
                    ignoreCodes: [151002],
                },
            },
        ],
    },
    extensionsToTreatAsEsm: [".ts"],
};

export default config;
