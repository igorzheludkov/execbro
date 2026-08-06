import { describe, expect, it, jest } from "@jest/globals";
import { pickWrittenField, typeAndVerify, type HidTypeDeps } from "../../core/hidTypeVerify.js";
import type { NativeField, NativeFieldsResult } from "../../core/nativeInputValue.js";

const field = (text: string | null, id: string | null = null): NativeField => ({ id, text, focused: false });

function deps(reads: NativeFieldsResult[], over: Partial<HidTypeDeps> = {}): HidTypeDeps {
    const queue = [...reads];
    return {
        // The last snapshot repeats, so a settled read is stable across polls.
        readFields: jest.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0])),
        type: jest.fn(async () => ({ success: true })),
        clear: jest.fn(async () => ({ success: true })),
        nonLatinKeyboards: jest.fn(async () => []),
        delay: async () => undefined,
        ...over
    } as HidTypeDeps;
}

describe("pickWrittenField", () => {
    it("picks the single field whose text changed", () => {
        expect(
            pickWrittenField([field("a"), field("")], [field("a"), field("hello")])
        ).toEqual({ previous: "", landed: "hello" });
    });

    it("refuses to guess when several fields changed", () => {
        expect(pickWrittenField([field(""), field("")], [field("x"), field("y")])).toBeNull();
    });

    it("refuses to guess when the tree grew and holds several fields", () => {
        expect(pickWrittenField([field("")], [field("x"), field("y")])).toBeNull();
    });

    it("answers for a single field even when nothing changed", () => {
        expect(pickWrittenField([field("same")], [field("same")])).toEqual({
            previous: "same",
            landed: "same"
        });
    });
});

describe("typeAndVerify", () => {
    it("verifies against the field, not against the request", async () => {
        const d = deps([{ fields: [field("")] }, { fields: [field("hello")] }]);
        const r = await typeAndVerify("hello", {}, d);
        expect(r.success).toBe(true);
        expect(r.verdict?.status).toBe("verified");
        expect(r.message).toContain('the field now reads "hello"');
    });

    it("fails loudly when the layout remaps ASCII into another script", async () => {
        // The reported case, reproduced on device: pure ASCII in, Cyrillic out.
        const d = deps(
            [{ fields: [field("")] }, { fields: [field("Ким Русь»учфьздуюсщь")] }],
            { nonLatinKeyboards: jest.fn(async () => ["uk_UA (Ukrainian)"]) }
        );
        const r = await typeAndVerify("envcheck@example.com", {}, d);
        expect(r.success).toBe(false);
        expect(r.verdict?.status).toBe("mismatch");
        expect(r.message).toContain("Cyrillic");
        expect(r.message).toContain("uk_UA (Ukrainian)");
    });

    it("expects the appended result when not replacing", async () => {
        const d = deps([{ fields: [field("hello ")] }, { fields: [field("hello world")] }]);
        const r = await typeAndVerify("world", {}, d);
        expect(r.verdict?.status).toBe("verified");
    });

    it("expects only the new text when replacing, and clears first", async () => {
        const d = deps([{ fields: [field("old")] }, { fields: [field("new")] }]);
        const r = await typeAndVerify("new", { replace: true }, d);
        expect(d.clear).toHaveBeenCalled();
        expect(r.verdict?.status).toBe("verified");
    });

    it("does not type when the clear failed", async () => {
        const d = deps([{ fields: [field("old")] }], {
            clear: jest.fn(async () => ({ success: false, error: "no focused TextInput" }))
        });
        const r = await typeAndVerify("new", { replace: true }, d);
        expect(r.success).toBe(false);
        expect(d.type).not.toHaveBeenCalled();
        expect(r.message).toContain("no focused TextInput");
    });

    it("reports unverified — not success — when the field cannot be read", async () => {
        const d = deps([{ fields: [], error: "axe describe-ui failed" }]);
        const r = await typeAndVerify("hello", {}, d);
        expect(r.verdict?.status).toBe("unverified");
        expect(r.message).toContain("NOT verified");
        // Unverified is not a failure of the write; the keystrokes did go out.
        expect(r.success).toBe(true);
    });

    it("surfaces a driver failure as a plain error", async () => {
        const d = deps([{ fields: [field("")] }], {
            type: jest.fn(async () => ({ success: false, error: "axe not installed" }))
        });
        const r = await typeAndVerify("hello", {}, d);
        expect(r.success).toBe(false);
        expect(r.message).toContain("axe not installed");
    });

    it("stops polling as soon as the expected text is there", async () => {
        const d = deps([{ fields: [field("")] }, { fields: [field("hi")] }]);
        await typeAndVerify("hi", {}, d);
        // one before-snapshot + one settled read
        expect((d.readFields as jest.Mock).mock.calls.length).toBe(2);
    });
});
