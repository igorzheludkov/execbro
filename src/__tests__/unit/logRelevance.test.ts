import { describe, it, expect } from "@jest/globals";
import { isRelevant } from "../../core/logRelevance.js";

describe("isRelevant", () => {
    it("drops owned-but-noisy debug messages", () => {
        // nativeloader / jni_lib_merge / SoLoader: 152 of the app's own 266
        // lines on a live device. Owned, and still pure noise.
        expect(isRelevant({ level: "debug", kind: "message" }, { minLevel: "warn" })).toBe(false);
    });

    it("keeps warnings at the default floor", () => {
        expect(isRelevant({ level: "warn", kind: "message" }, { minLevel: "warn" })).toBe(true);
    });

    it("keeps a crash even below the floor", () => {
        // The whole point of the feature: a level threshold must never be able
        // to suppress a crash.
        expect(isRelevant({ level: "debug", kind: "crash" }, { minLevel: "fatal" })).toBe(true);
    });

    it("keeps an ANR even below the floor", () => {
        expect(isRelevant({ level: "info", kind: "anr" }, { minLevel: "error" })).toBe(true);
    });

    it("opens the floodgates at minLevel debug", () => {
        expect(isRelevant({ level: "debug", kind: "message" }, { minLevel: "debug" })).toBe(true);
    });
});
