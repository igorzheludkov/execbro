import { describe, it, expect, jest } from "@jest/globals";

const { noteDialogOpened, noteDialogClosed } = await import("../../core/chromiumDialogs.js");
const calls: Array<Record<string, unknown>> = [];
const sendCdpCommand = jest.fn(async (ws: object, method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, ...params });
    if (method === "Page.handleJavaScriptDialog" && (ws as { gone?: boolean }).gone) throw new Error("Page.handleJavaScriptDialog: No dialog is showing");
    if (method === "Page.handleJavaScriptDialog") setTimeout(() => noteDialogClosed(ws, { result: params.accept === true, userInput: params.promptText as string | undefined }), 5);
    return {};
});
jest.unstable_mockModule("../../core/cdpCommand.js", () => ({ sendCdpCommand, evaluateJson: jest.fn() }));
const { answerDialog, pickDialogApp } = await import("../../core/chromiumDialogAnswer.js");
const { connectedApps } = await import("../../core/state.js");

const mk = () => ({ ws: {}, deviceInfo: { deviceName: "page" } }) as never as { ws: object; deviceInfo: { deviceName: string } };

describe("answerDialog", () => {
    it("accepts a prompt with text and reports the result", async () => {
        const app = mk();
        noteDialogOpened(app.ws, { type: "prompt", message: "Name?", url: "http://x/" });
        const r = await answerDialog(app as never, { action: "accept", promptText: "eb" });
        expect(r.isError).toBe(false);
        expect(calls.at(-1)).toMatchObject({ method: "Page.handleJavaScriptDialog", accept: true, promptText: "eb" });
        expect(JSON.parse(r.text)).toMatchObject({ answered: 'accepted a prompt dialog: "Name?"', result: true, userInput: "eb" });
    });
    it("with nothing open says so and names the last closed dialog, without calling CDP", async () => {
        const app = mk();
        noteDialogOpened(app.ws, { type: "alert", message: "Saved", url: "http://x/" });
        noteDialogClosed(app.ws, { result: true });
        const before = calls.length;
        const r = await answerDialog(app as never, { action: "dismiss" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/No dialog is open/);
        expect(r.text).toMatch(/alert dialog: "Saved"/);
        expect(calls.length).toBe(before);
    });
    it("refuses promptText on a non-prompt dialog", async () => {
        const app = mk();
        noteDialogOpened(app.ws, { type: "confirm", message: "Sure?", url: "http://x/" });
        const r = await answerDialog(app as never, { action: "accept", promptText: "x" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/promptText/);
    });
    it("a dialog closed by hand just before the answer reads as no dialog open, not a CDP error", async () => {
        const app = mk();
        noteDialogOpened(app.ws, { type: "alert", message: "Hi", url: "http://x/" });
        (app.ws as { gone?: boolean }).gone = true;
        const r = await answerDialog(app as never, { action: "accept" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/No dialog is open/);
        expect(r.text).toMatch(/alert dialog: "Hi"/);
    });
    it("a bare call picks the window that has the dialog, not just the first chromium window", () => {
        const first = { ws: {}, platform: "chromium", deviceInfo: { deviceName: "W1" } };
        const second = { ws: {}, platform: "chromium", deviceInfo: { deviceName: "W2" } };
        connectedApps.set("9997-W1", first as never);
        connectedApps.set("9997-W2", second as never);
        try {
            noteDialogOpened(second.ws, { type: "alert", message: "in W2", url: "http://x/" });
            expect(pickDialogApp(first as never, undefined)).toBe(second);
            expect(pickDialogApp(first as never, "W1")).toBe(first);
            expect(pickDialogApp(null, undefined)).toBe(second);
            expect(pickDialogApp(null, "iPhone")).toBeNull();
        } finally {
            connectedApps.delete("9997-W1");
            connectedApps.delete("9997-W2");
            noteDialogClosed(second.ws, { result: true });
        }
    });
});
