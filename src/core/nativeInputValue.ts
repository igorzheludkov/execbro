import { execAsync } from "./exec.js";

/**
 * Reading a field's text through the platform accessibility tree.
 *
 * React Native does NOT mirror an uncontrolled field's text back into fiber
 * props — verified on device, where the host's `text` prop stays undefined
 * after typing while mostRecentEventCount increments. So for uncontrolled
 * inputs the accessibility tree is the only read-back available, and without
 * it every such write is unverifiable and a corrupted one lands silently.
 *
 * Identity differs by platform:
 *   iOS      AXUniqueId carries the testID; there is NO focus attribute.
 *   Android  resource-id carries the testID, and focused="true" is exposed.
 *
 * Hence the fallback for a field with no testID: snapshot every field before
 * and after the write and require exactly one to have become the requested
 * text. That needs no identity at all.
 */
export type NativeField = {
    id: string | null;
    text: string | null;
    focused: boolean;
};

export type NativeFieldsResult = { fields: NativeField[]; error?: string };

/** iOS: `type: "TextField"` nodes carry AXUniqueId (testID) and AXValue. */
function parseIosFields(json: string): NativeField[] {
    const out: NativeField[] = [];
    let tree: unknown;
    try {
        tree = JSON.parse(json);
    } catch {
        return out;
    }
    const walk = (n: unknown): void => {
        if (Array.isArray(n)) {
            for (const v of n) walk(v);
            return;
        }
        if (!n || typeof n !== "object") return;
        const node = n as Record<string, unknown>;
        const type = typeof node.type === "string" ? node.type : "";
        if (type === "TextField" || type === "TextView") {
            out.push({
                id: typeof node.AXUniqueId === "string" ? node.AXUniqueId : null,
                text: typeof node.AXValue === "string" ? node.AXValue : null,
                // iOS exposes no focus flag; callers must not rely on it here.
                focused: false
            });
        }
        for (const v of Object.values(node)) walk(v);
    };
    walk(tree);
    return out;
}

/**
 * Android: an empty EditText reports its hint in `text`, so a value equal to
 * the hint is reported as empty rather than as content that happens to match.
 */
function parseAndroidFields(xml: string): NativeField[] {
    const out: NativeField[] = [];
    const nodeRe = /<node[^>]*class="android\.widget\.EditText"[^>]*\/?>/g;
    const attr = (s: string, name: string): string | null => {
        const m = new RegExp(`${name}="([^"]*)"`).exec(s);
        return m ? m[1] : null;
    };
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
        const s = m[0];
        const text = attr(s, "text");
        const hint = attr(s, "hint");
        out.push({
            id: attr(s, "resource-id"),
            text: text !== null && hint !== null && text === hint ? "" : text,
            focused: attr(s, "focused") === "true"
        });
    }
    return out;
}

export type NativeFieldsReader = (
    platform: "ios" | "android",
    deviceId?: string
) => Promise<NativeFieldsResult>;

export const readNativeFields: NativeFieldsReader = async (platform, deviceId) => {
    try {
        if (platform === "ios") {
            if (!deviceId) return { fields: [], error: "no simulator UDID" };
            const { stdout } = await execAsync(`axe describe-ui --udid ${deviceId}`, { timeout: 20_000 });
            return { fields: parseIosFields(stdout) };
        }
        const target = deviceId ? `-s ${deviceId}` : "";
        await execAsync(`adb ${target} shell uiautomator dump /sdcard/execbro-ui.xml`, { timeout: 20_000 });
        const { stdout } = await execAsync(`adb ${target} shell cat /sdcard/execbro-ui.xml`, { timeout: 20_000 });
        return { fields: parseAndroidFields(stdout) };
    } catch (e) {
        return { fields: [], error: e instanceof Error ? e.message : String(e) };
    }
};

/**
 * Pick the field a write landed in.
 *
 * By testID when there is one; else the focused field (Android only); else the
 * single field whose text changed. `null` means "could not determine", which
 * must surface as unverified rather than as a mismatch.
 */
export function resolveWrittenField(
    before: NativeField[],
    after: NativeField[],
    testID: string | null
): { text: string | null; via: "testID" | "focused" | "changed" } | null {
    if (testID) {
        const hit = after.find((f) => f.id === testID);
        if (hit) return { text: hit.text, via: "testID" };
    }

    const focused = after.filter((f) => f.focused);
    if (focused.length === 1) return { text: focused[0].text, via: "focused" };

    // No identity available: exactly one field must have changed.
    const changed = after.filter((f, i) => {
        const b = before[i];
        return b === undefined || b.text !== f.text;
    });
    if (changed.length === 1) return { text: changed[0].text, via: "changed" };

    return null;
}

export { parseIosFields, parseAndroidFields };
