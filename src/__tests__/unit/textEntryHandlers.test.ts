import { describe, it, expect, jest } from "@jest/globals";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean; _failureKind?: string }>;
const handlers = new Map<string, Handler>();

jest.unstable_mockModule("../../core/register.js", () => ({
    registerToolWithTelemetry: (_server: unknown, name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
    }
}));

let blurError = "no TextInput found on screen";
jest.unstable_mockModule("../../core/focusedInputTools.js", () => ({
    dismissKeyboard: async () => ({ success: false, error: blurError }),
    clearFocusedInput: async () => ({ success: true }),
    inputTextWithReplace: async () => ({ success: true })
}));

jest.unstable_mockModule("../../core/keyboardMetrics.js", () => ({
    readKeyboardState: async () => ({ visible: false })
}));

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: async () => ({ ok: false, error: { code: "NO_DEVICES_FOUND", message: "No devices found." } }),
    formatResolverError: (e: { message: string }) => e.message
}));

const { registerInteractionTools } = await import("../../tools/interactionTools.js");
registerInteractionTools({ registerTool: () => undefined } as never);

describe("dismiss_keyboard with nothing to blur", () => {
    it("reports the keyboard already down when the screen has no inputs at all", async () => {
        blurError = "no TextInput found on screen";
        const r = await handlers.get("dismiss_keyboard")!({});
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).toContain("already down");
    });

    it("still does so when no input has focus", async () => {
        blurError = "no focused TextInput. Pass testID";
        const r = await handlers.get("dismiss_keyboard")!({});
        expect(r.isError).toBeFalsy();
    });
});

describe("input_text device resolution failure", () => {
    it("carries the failure kind of the connection state", async () => {
        const r = await handlers.get("input_text")!({ text: "hi" });
        expect(r.isError).toBe(true);
        // Nothing is connected in this test, and no device was named.
        expect(r._failureKind).toBe("no_apps_connected");
    });
});
