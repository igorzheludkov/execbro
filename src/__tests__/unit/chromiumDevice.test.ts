import { describe, it, expect } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { ConnectedApp } from "../../core/types.js";
import { chromiumCapture } from "../../core/chromium.js";
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
