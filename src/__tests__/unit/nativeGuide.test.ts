import { describe, it, expect } from "@jest/globals";
import { getGuideByTopic, getAvailableTopics, DECISION_TREE } from "../../core/guides.js";

describe("native guide", () => {
    it("is a listed topic covering setup and the four tools", () => {
        expect(getAvailableTopics()).toContain("native");
        const guide = getGuideByTopic("native")!;
        for (const s of ["execbro-sdk-android", "ExecBro.init", "run_app_command", "inspect_global", "navigate", "list_debug_globals"]) {
            expect(guide).toContain(s);
        }
    });

    it("is announced in the decision tree", () => {
        expect(DECISION_TREE).toContain("native");
        expect(DECISION_TREE).toContain("run_app_command");
    });
});
