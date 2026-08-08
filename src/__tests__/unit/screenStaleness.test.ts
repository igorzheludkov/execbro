import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    diagnoseStaleness,
    inputIdentity,
    recordScreen,
    recordToolCall,
    resetScreenStalenessForTests
} from "../../core/screenStaleness.js";

const DEV = "iPhone 17";

describe("screenStaleness", () => {
    beforeEach(() => resetScreenStalenessForTests());

    it("reports a genuine miss when the screen is unchanged", () => {
        recordScreen(DEV, { elements: ["email", "password"], focused: true }, 1000);
        recordToolCall("get_screen_state", 1100);

        const v = diagnoseStaleness(DEV, { elements: ["password", "email"], focused: true }, 2000);

        expect(v.kind).toBe("genuine_miss");
        expect(v.tag).toBe("");
    });

    it("reports a genuine miss with no baseline — a guess that excuses a real miss is worse than no signal", () => {
        expect(diagnoseStaleness(DEV, { elements: ["a"], focused: false }, 2000).kind).toBe("genuine_miss");
    });

    it("calls a wholesale element swap a navigation race", () => {
        recordScreen(DEV, { elements: ["email", "password"], focused: true }, 1000);
        recordToolCall("get_screen_state", 1100);

        const v = diagnoseStaleness(DEV, { elements: ["card-number", "cvv"], focused: false }, 4200);

        expect(v.kind).toBe("stale_navigation");
        expect(v.tag).toBe("screen_changed:navigation");
        expect(v.agoMs).toBe(3200);
        expect(v.note).toContain("3.2s");
    });

    it("calls a partial element change an in-screen race", () => {
        recordScreen(DEV, { elements: ["email", "password"], focused: true }, 1000);
        recordToolCall("get_screen_state", 1100);

        const v = diagnoseStaleness(DEV, { elements: ["email", "password", "promo"], focused: true }, 1500);

        expect(v.kind).toBe("stale_inscreen");
        expect(v.tag).toBe("screen_changed:inscreen");
    });

    it("calls a lost focus on an otherwise identical screen an in-screen race", () => {
        recordScreen(DEV, { elements: ["email"], focused: true }, 1000);
        recordToolCall("get_screen_state", 1100);

        const v = diagnoseStaleness(DEV, { elements: ["email"], focused: false }, 1500);

        expect(v.kind).toBe("stale_inscreen");
        expect(v.note).toContain("lost focus");
    });

    // The whole point: an agent's own tap is supposed to change the screen, and
    // counting that as interference would flag every ordinary multi-step flow.
    it("does not blame a race when the agent's own mutating tool moved the screen", () => {
        recordScreen(DEV, { elements: ["email", "password"], focused: true }, 1000);
        recordToolCall("tap", 1200);

        const v = diagnoseStaleness(DEV, { elements: ["card-number", "cvv"], focused: false }, 1500);

        expect(v.kind).toBe("genuine_miss");
    });

    // Regression: `lastTool` used to hold only the most recent tool, so a read
    // between the agent's own tap and the miss erased the fact that the agent
    // had moved the screen — and `tap -> get_screen_state -> input_text` is the
    // common loop. Every such miss was reported as a passer-by.
    it("does not blame a race when a READ ran after the agent's own mutating tool", () => {
        recordScreen(DEV, { elements: ["cart-item", "checkout-btn"], focused: false }, 100);
        recordToolCall("tap", 200);
        recordToolCall("get_screen_state", 300);

        const v = diagnoseStaleness(DEV, { elements: ["card-number", "cvv"], focused: false }, 400);

        expect(v.kind).toBe("genuine_miss");
    });

    // The other half of the fix: a baseline taken AFTER the agent's action —
    // which is what get_screen_state now records — lets a real race through.
    it("blames a race when the screen moved after the agent's last look at it", () => {
        recordToolCall("tap", 200);
        recordScreen(DEV, { elements: ["card-number", "cvv"], focused: false }, 300);
        recordToolCall("get_screen_state", 300);

        const v = diagnoseStaleness(DEV, { elements: ["home-feed", "search"], focused: false }, 900);

        expect(v.kind).toBe("stale_navigation");
    });

    it("still blames a race when the agent's mutating tool ran BEFORE the baseline", () => {
        recordToolCall("tap", 900);
        recordScreen(DEV, { elements: ["email", "password"], focused: true }, 1000);

        const v = diagnoseStaleness(DEV, { elements: ["card-number", "cvv"], focused: false }, 1500);

        expect(v.kind).toBe("stale_navigation");
    });

    it("keeps devices apart", () => {
        recordScreen("iphone", { elements: ["email"], focused: true }, 1000);
        recordToolCall("get_screen_state", 1100);

        expect(diagnoseStaleness("pixel", { elements: ["totally-different"], focused: false }, 1500).kind)
            .toBe("genuine_miss");
    });

    it("re-baselines as it diagnoses, so one race is not reported twice", () => {
        recordScreen(DEV, { elements: ["email"], focused: true }, 1000);
        recordToolCall("get_screen_state", 1100);

        expect(diagnoseStaleness(DEV, { elements: ["cvv"], focused: false }, 1500).kind).toBe("stale_navigation");
        expect(diagnoseStaleness(DEV, { elements: ["cvv"], focused: false }, 1600).kind).toBe("genuine_miss");
    });

    describe("inputIdentity", () => {
        it("prefers testID", () => {
            expect(inputIdentity({ testID: "email", placeholder: "E-mail" })).toBe("email");
        });

        // Typing into a field changes its value; an identity that moved with the
        // value would report every successful write as the screen having moved.
        it("ignores the field's value", () => {
            const before = inputIdentity({ component: "FormInput", placeholder: "Name", label: "Name" });
            const after = inputIdentity({ component: "FormInput", placeholder: "Name", label: "Name" });
            expect(before).toBe(after);
        });

        it("falls back to a marker rather than collapsing every blank field onto one identity", () => {
            expect(inputIdentity({})).toBe("?");
        });
    });
});
