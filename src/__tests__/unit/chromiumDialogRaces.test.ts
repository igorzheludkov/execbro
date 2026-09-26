// Set test mode BEFORE importing anything that may pull in src/index.ts.
process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect, jest } from "@jest/globals";

const ws = {};
const { noteDialogOpened, noteDialogClosed } = await import("../../core/chromiumDialogs.js");
const sendCdpCommand = jest.fn(async (_ws: unknown, method: string, params: Record<string, unknown> = {}) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        setTimeout(() => noteDialogOpened(ws, { type: "confirm", message: "Delete?", url: "http://x/" }), 5);
        return new Promise(() => {});
    }
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
        setTimeout(() => noteDialogOpened(ws, { type: "alert", message: "Sent", url: "http://x/" }), 5);
        return new Promise(() => {});
    }
    if (method === "Page.captureScreenshot") return new Promise(() => {});
    return {};
});
const evaluateJson = jest.fn(async (_ws: unknown, js: string) => {
    if (js.includes("innerWidth")) return { w: 800, h: 600, dpr: 1 };
    return null;
});
jest.unstable_mockModule("../../core/cdpCommand.js", () => ({ sendCdpCommand, evaluateJson }));

const { chromiumTap, verifyChromiumAction } = await import("../../pro/chromiumTap.js");
const { chromiumPressKey } = await import("../../pro/chromiumKeys.js");
const { parseKeyCombo } = await import("../../core/chromium.js");
const { executeInApp } = await import("../../core/jsExecute.js");
const { connectedApps } = await import("../../core/state.js");
const app = { ws, deviceInfo: { deviceName: "page" } } as never;

describe("dialog races", () => {
    it("a click that opens a dialog returns the dialog instead of timing out", async () => {
        const r = await chromiumTap(app, { x: 10, y: 10 }, { verify: false, screenshot: false });
        expect(r.success).toBe(true);
        expect(r.dialog).toMatchObject({ type: "confirm", message: "Delete?" });
        expect(r.verification?.skippedReason).toBe("dialog open");
        noteDialogClosed(ws, { result: false });
    });
    it("a dialog opening after the input, during the after-capture, is reported too", async () => {
        setTimeout(() => noteDialogOpened(ws, { type: "alert", message: "Later", url: "http://x/" }), 5);
        const v = await verifyChromiumAction(app, null, true, "click", 0);
        expect(v.dialog).toMatchObject({ message: "Later" });
        noteDialogClosed(ws, { result: true });
    });
    it("a dialog that opened during the settle, before the capture started, is reported too", async () => {
        setTimeout(() => noteDialogOpened(ws, { type: "alert", message: "Settle", url: "http://x/" }), 5);
        const v = await verifyChromiumAction(app, null, true, "click", 40);
        expect(v.dialog).toMatchObject({ message: "Settle" });
        noteDialogClosed(ws, { result: true });
    });
    it("press_key stops repeating at the dialog and reports it", async () => {
        const combo = parseKeyCombo("Enter");
        if ("error" in combo) throw new Error(combo.error);
        const r = await chromiumPressKey(app, { input: "Enter", combo, repeat: 3 });
        expect(r.isError).toBe(false);
        expect(r.content[0].text).toMatch(/"dialog"/);
        expect(r.content[0].text).toMatch(/Sent/);
        expect(JSON.parse(r.content[0].text).sent).toBe(1);
        noteDialogClosed(ws, { result: true });
    });
    it("execute_in_app that opens a dialog returns the dialog error, not the timeout text", async () => {
        const pws = {
            readyState: 1, on: () => {}, removeListener: () => {}, close: () => {},
            send: () => { setTimeout(() => noteDialogOpened(pws, { type: "alert", message: "eb alert", url: "http://x/" }), 5); },
        };
        connectedApps.set("9998-Dlg", { ws: pws, deviceInfo: { id: "Dlg", title: "DlgPage", deviceName: "DlgPage", webSocketDebuggerUrl: "ws://x/Dlg" }, port: 9998, platform: "chromium" } as never);
        try {
            const t0 = Date.now();
            const r = await executeInApp("alert('eb alert')", false, { timeoutMs: 3000, skipBootstrap: true }, "DlgPage");
            expect(Date.now() - t0).toBeLessThan(1500);
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/alert dialog: "eb alert"/);
            expect(r.error).not.toMatch(/scan_metro/);
            expect(r.failureKind).toBe("js_dialog_open");
        } finally {
            connectedApps.delete("9998-Dlg");
            noteDialogClosed(pws, { result: true });
        }
    });
    it("a dialog whose page text reads like a transport error does not trigger a reconnect", async () => {
        const msg = "target closed: WebSocket connection is not open";
        const pws = {
            readyState: 1, on: () => {}, removeListener: () => {}, close: jest.fn(),
            send: () => { setTimeout(() => noteDialogOpened(pws, { type: "alert", message: msg, url: "http://x/" }), 5); },
        };
        connectedApps.set("9998-Dlg2", { ws: pws, deviceInfo: { id: "Dlg2", title: "DlgPage2", deviceName: "DlgPage2", webSocketDebuggerUrl: "ws://x/Dlg2" }, port: 9998, platform: "chromium" } as never);
        try {
            const r = await executeInApp("alert(1)", false, { timeoutMs: 3000, skipBootstrap: true }, "DlgPage2");
            expect(r.error).toMatch(/^The expression opened an? alert dialog/);
            expect(pws.close).not.toHaveBeenCalled();
            expect(connectedApps.has("9998-Dlg2")).toBe(true);
        } finally {
            connectedApps.delete("9998-Dlg2");
            noteDialogClosed(pws, { result: true });
        }
    });
});
