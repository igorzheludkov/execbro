import { describe, it, expect, jest } from "@jest/globals";

// Answers each injected script by what it is; never touches a socket.
const evaluateJson = jest.fn(async (_ws: unknown, js: string): Promise<unknown> => {
    if (js.includes("__eb_domTargets = els")) {
        return { viewport: { w: 800, h: 600, dpr: 1 }, focused: false, total: 1, candidates: [{ i: 0, tag: "input", text: "", testID: "note", label: null, placeholder: null, value: "abc", rect: { x: 0, y: 0, w: 10, h: 10 } }] };
    }
    if (js.includes("Retry.\" });\n    var F =")) return { focused: false };
    return null;
});
const sendCdpCommand = jest.fn(async () => ({}));
jest.unstable_mockModule("../../core/cdpCommand.js", () => ({ evaluateJson, sendCdpCommand }));

const { chromiumPressKey } = await import("../../pro/chromiumKeys.js");
const { parseKeyCombo } = await import("../../core/chromium.js");

describe("chromiumPressKey", () => {
    it("refuses to send keys when the target did not take focus, so they cannot land in another field", async () => {
        const combo = parseKeyCombo("Backspace");
        if ("error" in combo) throw new Error(combo.error);
        const app = { ws: {}, deviceInfo: { deviceName: "page" } } as never;
        const r = await chromiumPressKey(app, { input: "Backspace", combo, repeat: 10, testID: "note" });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/did not take focus/);
        expect(sendCdpCommand).not.toHaveBeenCalled();
    });
});
