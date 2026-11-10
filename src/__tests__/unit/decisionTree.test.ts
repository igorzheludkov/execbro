import { describe, it, expect } from "@jest/globals";

const { DECISION_TREE } = await import("../../core/guides.js");

// Sonnet suite Cs: C1 runs edited from the code alone and shipped the decoy, and
// a C2 run checked its fix right after reload_app, in a state without the bug.
const LINES = [
    "Fixing a bug: reproduce it on the device first. When the cause depends on data the app stores or receives (saved state, API responses), read that data in the running app (execute_in_app, redux_get_state, get_network_requests) before editing: the code alone can point to the wrong fix.",
    "Before saying a fix works: rebuild the state the bug needed (screen, data, overlays), repeat the user's steps with tap / swipe / input_text, and report what you saw. A check right after reload_app starts from a reset app and can pass without the fix."
];

describe("server instructions", () => {
    it("decision tree tells the agent to check data and state when fixing a bug", () => {
        for (const line of LINES) {
            expect(DECISION_TREE).toContain(line);
            expect(line).not.toMatch(/[—–]/);
        }
    });
});
