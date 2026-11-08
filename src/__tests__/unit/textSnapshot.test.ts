import { describe, it, expect } from "@jest/globals";
import { walkTextSnapshot, TEXT_SNAPSHOT_HELPERS_JS } from "../../core/textSnapshot.js";

type F = { type: unknown; memoizedProps?: Record<string, unknown> | string; child?: F | null; sibling?: F | null };

/** Builds a fiber tree from nested arrays: [type, props, ...children]. */
function tree(node: [unknown, (Record<string, unknown> | string)?, ...unknown[]]): F {
    const [type, props, ...kids] = node;
    // A HostText fiber (the raw string inside a <Text>) has type null and the string itself as props.
    const f: F = { type, memoizedProps: (typeof props === "string" ? props : props ?? {}) as F["memoizedProps"], child: null, sibling: null };
    let prev: F | null = null;
    for (const k of kids as Array<[unknown, (Record<string, unknown> | string)?, ...unknown[]]>) {
        const c = tree(k);
        if (prev) prev.sibling = c;
        else f.child = c;
        prev = c;
    }
    return f;
}

// Runs exactly as injected: the helpers and the walker from their source text.
const walk = new Function(`${TEXT_SNAPSHOT_HELPERS_JS}; var w = ${walkTextSnapshot.toString()}; return w;`)() as (root: F) => string[];

const Screen = function Screen() {};
const TextInput = function TextInput() {};
const Switch = function Switch() {};

describe("buildTextSnapshotExpression", () => {
    it("is one parseable script (nav sources, helpers and walker together)", async () => {
        const { buildTextSnapshotExpression } = await import("../../core/textSnapshot.js");
        expect(() => new Function(buildTextSnapshotExpression())).not.toThrow();
    });
});

describe("walkTextSnapshot", () => {
    it("joins a Text's raw pieces into one line, the way it reads on screen", () => {
        // <Text>Taps: {count}</Text> renders two HostText fibers under the RCTText host.
        const root = tree(["RCTView", {}, ["RCTText", {}, [null, "Taps: "], [null, "1"]]]);
        expect(walk(root)).toEqual(["Taps: 1"]);
    });

    it("skips inactive navigator screens", () => {
        const root = tree(["RCTView", {}, [Screen, { activityState: 0 }, ["RCTText", {}, [null, "Hidden tab"]]], ["RCTText", {}, [null, "Visible"]]]);
        expect(walk(root)).toEqual(["Visible"]);
    });

    it("reads inputs by name with a masked value", () => {
        const root = tree(["RCTView", {}, [TextInput, { onChangeText: () => {}, placeholder: "Password", secureTextEntry: true, value: "hunter22" }], [TextInput, { onChangeText: () => {}, testID: "email" }]]);
        expect(walk(root)).toEqual(["Password: [masked, 8 chars]", "email: (empty)"]);
    });

    it("masks a password wrapper whose secure input is a child", () => {
        const root = tree(["RCTView", {}, [function PasswordInput() {}, { onChangeText: () => {}, placeholder: "Password", value: "hunter22" }, [TextInput, { secureTextEntry: true }]]]);
        expect(walk(root)).toEqual(["Password: [masked, 8 chars]"]);
    });

    it("reads switch values", () => {
        const root = tree(["RCTView", {}, [Switch, { value: true, accessibilityLabel: "Notifications", onValueChange: () => {} }]]);
        expect(walk(root)).toEqual(["[switch:ON] Notifications"]);
    });
});
