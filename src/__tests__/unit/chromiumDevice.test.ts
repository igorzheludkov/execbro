import { describe, it, expect } from "@jest/globals";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import type { ConnectedApp } from "../../core/types.js";
import { chromiumCapture, chromiumInputText } from "../../core/chromium.js";
import { chromiumTap } from "../../pro/chromiumTap.js";

type Msg = { id: number; method: string; params: { expression?: string } };

/** A CDP socket that answers each command from a script, keyed on method (and expression text for Runtime.evaluate). */
class ScriptedWs extends EventEmitter {
    sent: Msg[] = [];
    constructor(private answer: (m: Msg) => unknown) { super(); }
    send(s: string) {
        const m = JSON.parse(s) as Msg;
        this.sent.push(m);
        queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: m.id, result: this.answer(m) }))));
    }
}
const value = (v: unknown) => ({ result: { type: "string", value: JSON.stringify(v) } });
const appOn = (ws: ScriptedWs) => ({ ws, deviceInfo: { deviceName: "FluentTalk" }, platform: "chromium" } as unknown as ConnectedApp);

describe("chromiumCapture on a hidden window", () => {
    it("fails immediately without asking Chromium for a frame it will never paint", async () => {
        const ws = new ScriptedWs(() => value({ w: 380, h: 600, dpr: 1, hidden: true }));
        await expect(chromiumCapture(appOn(ws))).rejects.toThrow(/hidden/);
        expect(ws.sent.map((m) => m.method)).toEqual(["Runtime.evaluate"]);
    });
});

describe("chromiumTap scroll note", () => {
    it("says when the target was scrolled into view first", async () => {
        const ws = new ScriptedWs((m) => {
            if (m.method !== "Runtime.evaluate") return {};
            if (m.params.expression!.includes("__eb_domTargets = els")) {
                return value({
                    viewport: { w: 380, h: 600, dpr: 1 }, focused: false, total: 1,
                    candidates: [{ i: 0, tag: "p", text: "back to life", testID: null, label: null, placeholder: null, value: null, rect: { x: 10, y: 700, w: 100, h: 20 } }],
                });
            }
            return value({ x: 60, y: 444, scrolled: true, covered: null });
        });
        const r = await chromiumTap(appOn(ws), { text: "back to life" }, { verify: false, screenshot: false });
        expect(r.success).toBe(true);
        expect(r.warning).toMatch(/scrolled into view/i);
    });
});

describe("chromiumTap on a hidden window", () => {
    it("refuses before clicking, with verify:false too", async () => {
        const ws = new ScriptedWs((m) => {
            if (m.method !== "Runtime.evaluate") return {};
            if (m.params.expression!.includes("__eb_domTargets = els")) {
                return value({
                    viewport: { w: 380, h: 600, dpr: 1, hidden: true }, focused: false, total: 1,
                    candidates: [{ i: 0, tag: "button", text: "Save", testID: null, label: null, placeholder: null, value: null, rect: { x: 10, y: 10, w: 100, h: 20 } }],
                });
            }
            return value({ w: 380, h: 600, dpr: 1, hidden: true, x: 60, y: 20, scrolled: false, covered: null });
        });
        const r = await chromiumTap(appOn(ws), { text: "Save" }, { verify: false, screenshot: false });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/hidden/);
        expect(ws.sent.some((m) => m.method === "Input.dispatchMouseEvent")).toBe(false);
        const c = await chromiumTap(appOn(ws), { x: 10, y: 10 }, { verify: false, screenshot: false });
        expect(c.success).toBe(false);
        expect(ws.sent.some((m) => m.method === "Input.dispatchMouseEvent")).toBe(false);
    });
});

describe("chromiumInputText into an empty rich-text editor", () => {
    it("verifies an append when the editor's empty paragraph reads as a lone newline", async () => {
        const ws = new ScriptedWs((m) => {
            if (m.method === "Input.insertText") return {};
            const e = m.params.expression!;
            if (e.includes("__eb_domTargets = els")) {
                return value({
                    viewport: { w: 380, h: 600, dpr: 1 }, focused: true, total: 1,
                    candidates: [{ i: 0, tag: "div", text: "", testID: null, label: null, placeholder: null, value: "\n", rect: { x: 0, y: 0, w: 300, h: 40 } }],
                });
            }
            if (e.includes("el.focus()")) return value({ before: "\n", field: false, focused: true, maxLength: null });
            return value({ value: "hi\n" });
        });
        const r = await chromiumInputText(appOn(ws), { text: "hi" });
        expect(r).toMatchObject({ success: true, verified: true, value: "hi" });
    });
});

describe("chromiumTap when the click hides its own window", () => {
    it("reports the delivered click as a success, not a failure an agent would retry", async () => {
        const png = (await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).png().toBuffer()).toString("base64");
        let viewportReads = 0;
        const ws = new ScriptedWs((m) => {
            if (m.method === "Page.captureScreenshot") return { data: png };
            if (m.method !== "Runtime.evaluate") return {};
            const e = m.params.expression!;
            if (e.includes("__eb_domTargets = els")) {
                return value({
                    viewport: { w: 4, h: 4, dpr: 1 }, focused: false, total: 1,
                    candidates: [{ i: 0, tag: "button", text: "Save & close", testID: null, label: null, placeholder: null, value: null, rect: { x: 0, y: 0, w: 4, h: 4 } }],
                });
            }
            if (e.includes("elementFromPoint")) return value({ x: 2, y: 2, scrolled: false, covered: null });
            viewportReads++;
            return value({ w: 4, h: 4, dpr: 1, hidden: viewportReads > 1 });
        });
        const r = await chromiumTap(appOn(ws), { text: "Save & close" }, {});
        expect(r.success).toBe(true);
        expect(ws.sent.filter((m) => m.params && (m.params as Record<string, unknown>).type === "mousePressed")).toHaveLength(1);
        expect(r.verification?.explanation).toMatch(/hid/);
    });
});
