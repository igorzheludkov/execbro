import { describe, expect, it } from "@jest/globals";
import { parseIosFields, parseAndroidFields, resolveWrittenField } from "../../core/nativeInputValue.js";

describe("parseIosFields", () => {
    it("reads AXUniqueId as the testID and AXValue as the text", () => {
        const json = JSON.stringify({
            children: [
                { type: "TextField", AXUniqueId: "name-input", AXValue: "Alice" },
                { type: "Other", children: [{ type: "TextField", AXUniqueId: null, AXValue: "Email" }] }
            ]
        });
        expect(parseIosFields(json)).toEqual([
            { id: "name-input", text: "Alice", focused: false },
            { id: null, text: "Email", focused: false }
        ]);
    });

    it("returns nothing rather than throwing on unparseable output", () => {
        expect(parseIosFields("not json")).toEqual([]);
    });
});

describe("parseAndroidFields", () => {
    const node = (attrs: string) => `<node class="android.widget.EditText" ${attrs}/>`;

    it("reads resource-id, text and focused", () => {
        const xml = node('resource-id="name-input" text="Alice" hint="Enter name" focused="true"');
        expect(parseAndroidFields(xml)).toEqual([{ id: "name-input", text: "Alice", focused: true }]);
    });

    it("treats text equal to the hint as empty", () => {
        // An empty Android EditText reports its hint in `text`; taking that at
        // face value would verify a write that never happened.
        const xml = node('resource-id="email-input" text="Email" hint="Email" focused="false"');
        expect(parseAndroidFields(xml)).toEqual([{ id: "email-input", text: "", focused: false }]);
    });

    it("ignores non-EditText nodes", () => {
        expect(parseAndroidFields('<node class="android.widget.TextView" text="hi"/>')).toEqual([]);
    });
});

describe("resolveWrittenField", () => {
    const f = (id: string | null, text: string | null, focused = false) => ({ id, text, focused });

    it("prefers the testID when there is one", () => {
        const after = [f("a", "one"), f("b", "two")];
        expect(resolveWrittenField(after, after, "b")).toEqual({ text: "two", via: "testID" });
    });

    it("falls back to the focused field when there is no testID", () => {
        const after = [f(null, "one"), f(null, "two", true)];
        expect(resolveWrittenField(after, after, null)).toEqual({ text: "two", via: "focused" });
    });

    it("falls back to the single changed field when nothing identifies it", () => {
        // iOS exposes no focus flag, so a field with no testID is only findable
        // by what changed.
        const before = [f(null, "one"), f(null, "")];
        const after = [f(null, "one"), f(null, "Alice")];
        expect(resolveWrittenField(before, after, null)).toEqual({ text: "Alice", via: "changed" });
    });

    it("returns null when several fields changed", () => {
        const before = [f(null, ""), f(null, "")];
        const after = [f(null, "x"), f(null, "y")];
        expect(resolveWrittenField(before, after, null)).toBeNull();
    });

    it("returns null when nothing changed and nothing identifies the field", () => {
        const same = [f(null, "one"), f(null, "two")];
        expect(resolveWrittenField(same, same, null)).toBeNull();
    });

    it("does not silently match a different testID", () => {
        const after = [f("a", "one")];
        expect(resolveWrittenField(after, after, "missing")).toBeNull();
    });
});
