import { describe, it, expect } from "@jest/globals";
import {
    noteDialogOpened, noteDialogClosed, openDialog, lastClosedDialog, onDialogOpened,
    waitForDialogClosed, raceDialog, formatDialog, dialogGate, DIALOG_BLOCKED_TOOLS,
} from "../../core/chromiumDialogs.js";

const opening = (message = "Delete it?", type = "confirm") => ({ type, message, url: "http://x/", defaultPrompt: "" });

describe("tracker", () => {
    it("records an open dialog per socket and clears it on close", () => {
        const a = {}, b = {};
        noteDialogOpened(a, opening());
        expect(openDialog(a)).toMatchObject({ type: "confirm", message: "Delete it?" });
        expect(openDialog(b)).toBeNull();
        noteDialogClosed(a, { result: true });
        expect(openDialog(a)).toBeNull();
        expect(lastClosedDialog(a)).toMatchObject({ message: "Delete it?", result: true });
    });
    it("an unknown type is kept as alert rather than dropped", () => {
        const a = {};
        noteDialogOpened(a, opening("hi", "weird"));
        expect(openDialog(a)?.type).toBe("alert");
    });
    it("notifies subscribers of an opening, and unsubscribes", () => {
        const a = {};
        const seen: string[] = [];
        const off = onDialogOpened(a, (d) => seen.push(d.message));
        noteDialogOpened(a, opening("one"));
        off();
        noteDialogOpened(a, opening("two"));
        expect(seen).toEqual(["one"]);
    });
    it("waitForDialogClosed resolves true on close, false on timeout", async () => {
        const a = {};
        noteDialogOpened(a, opening());
        const w = waitForDialogClosed(a, 1000);
        noteDialogClosed(a, { result: false });
        expect(await w).toBe(true);
        noteDialogOpened(a, opening());
        expect(await waitForDialogClosed(a, 20)).toBe(false);
    });
});

describe("raceDialog", () => {
    it("returns the value when no dialog opens", async () => {
        expect(await raceDialog({}, Promise.resolve(7))).toEqual({ kind: "done", value: 7 });
    });
    it("returns the dialog when one opens first, and swallows the late rejection of the loser", async () => {
        const a = {};
        let reject!: (e: Error) => void;
        const hung = new Promise<void>((_, r) => { reject = r; });
        const race = raceDialog(a, hung);
        noteDialogOpened(a, opening("Sure?"));
        expect(await race).toMatchObject({ kind: "dialog", dialog: { message: "Sure?" } });
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on("unhandledRejection", onUnhandled);
        reject(new Error("Input.dispatchMouseEvent timed out"));
        await new Promise((r) => setTimeout(r, 10));
        process.off("unhandledRejection", onUnhandled);
        expect(unhandled).toEqual([]);
    });
    it("passes a rejection through when no dialog opened", async () => {
        await expect(raceDialog({}, Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
});

describe("formatDialog and dialogGate", () => {
    it("quotes and truncates the page-controlled message", () => {
        const a = {};
        noteDialogOpened(a, opening("x".repeat(500), "prompt"));
        const s = formatDialog(openDialog(a)!);
        expect(s).toMatch(/^a prompt dialog: "x+…"$/);
        expect(s.length).toBeLessThan(230);
    });
    it("refuses a page-touching tool with the exact handle_dialog call", () => {
        const a = {};
        noteDialogOpened(a, opening("Delete it?"));
        const r = dialogGate("tap", openDialog(a));
        expect(r?.isError).toBe(true);
        expect(r?._failureKind).toBe("js_dialog_open");
        expect(r?.content[0].text).toMatch(/confirm dialog: "Delete it\?"/);
        expect(r?.content[0].text).toMatch(/handle_dialog\(\{ action: "accept" \}\)/);
    });
    it("lets buffer-only tools through, and does nothing without a dialog", () => {
        const a = {};
        noteDialogOpened(a, opening());
        expect(dialogGate("get_logs", openDialog(a))).toBeNull();
        expect(dialogGate("handle_dialog", openDialog(a))).toBeNull();
        expect(dialogGate("tap", null)).toBeNull();
        expect(DIALOG_BLOCKED_TOOLS.has("execute_in_app")).toBe(true);
        expect(DIALOG_BLOCKED_TOOLS.has("get_network_requests")).toBe(false);
    });
    it("mentions promptText for a prompt", () => {
        const a = {};
        noteDialogOpened(a, opening("Name?", "prompt"));
        expect(dialogGate("screenshot", openDialog(a))?.content[0].text).toMatch(/promptText/);
    });
});
