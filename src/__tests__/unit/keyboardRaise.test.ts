import { describe, expect, it, jest } from "@jest/globals";
import { raiseKeyboard, type RaiseDeps } from "../../core/keyboardRaise.js";
import type { KeyboardState } from "../../core/keyboardMetrics.js";

const visible: KeyboardState = { visible: true, height: 345, screenY: 567, width: 420 };
const hidden: KeyboardState = { visible: false, height: null, screenY: null, width: null };

function deps(states: KeyboardState[], over: Partial<RaiseDeps> = {}) {
    const queue = [...states];
    const d: RaiseDeps = {
        readState: jest.fn(async () => queue.shift() ?? states[states.length - 1]),
        runOsascript: jest.fn(async () => ""),
        runAdb: jest.fn(async () => ""),
        delay: jest.fn(async () => {}),
        ...over
    };
    return d;
}

describe("raiseKeyboard", () => {
    it("does nothing when the keyboard is already up", async () => {
        const d = deps([visible]);
        const r = await raiseKeyboard("ios", "UDID", d);
        expect(r).toEqual({ raised: true, changed: false });
        // Firing the toggle here would HIDE it — the menu item toggles, not shows.
        expect(d.runOsascript).not.toHaveBeenCalled();
    });

    it("iOS: activates Simulator first, and never touches ConnectHardwareKeyboard", async () => {
        const d = deps([hidden, visible]);
        const r = await raiseKeyboard("ios", "UDID", d);
        expect(r).toEqual({ raised: true, changed: true });
        const script = (d.runOsascript as jest.Mock).mock.calls[0][0] as string;
        expect(script).toContain('tell application "Simulator" to activate');
        expect(script).toContain("Toggle Software Keyboard");
        // Toggling the hardware keyboard would rewrite a persistent user setting.
        expect(script).not.toContain("Connect Hardware Keyboard");
    });

    it("android: flips show_ime_with_hard_keyboard on the target device", async () => {
        const d = deps([hidden, visible]);
        await raiseKeyboard("android", "emulator-5554", d);
        const args = (d.runAdb as jest.Mock).mock.calls[0][0] as string[];
        expect(args.join(" ")).toContain("-s emulator-5554");
        expect(args.join(" ")).toContain("show_ime_with_hard_keyboard 1");
    });

    it("reports a reason instead of throwing when osascript fails", async () => {
        const d = deps([hidden], {
            runOsascript: jest.fn(async () => {
                throw new Error("osascript error 1002: not authorised to send Apple events");
            })
        });
        const r = await raiseKeyboard("ios", "UDID", d);
        expect(r.raised).toBe(false);
        expect(r.reason).toContain("1002");
    });

    it("reports a reason when the CDP read fails across activate", async () => {
        const d = deps([hidden, { ...hidden, error: "No apps connected" }]);
        const r = await raiseKeyboard("ios", "UDID", d);
        expect(r).toMatchObject({ raised: false, changed: true, reason: "No apps connected" });
    });

    it("does not claim success when the toggle ran but nothing appeared", async () => {
        const d = deps([hidden, hidden]);
        const r = await raiseKeyboard("ios", "UDID", d);
        expect(r.raised).toBe(false);
        expect(r.reason).toContain("did not appear");
    });

    it("bails out with a reason when the state cannot be read at all", async () => {
        const d = deps([{ ...hidden, error: "Keyboard module unavailable" }]);
        const r = await raiseKeyboard("android", "emulator-5554", d);
        expect(r).toEqual({ raised: false, changed: false, reason: "Keyboard module unavailable" });
        expect(d.runAdb).not.toHaveBeenCalled();
    });

    it("waits for the animation before re-reading visibility", async () => {
        const d = deps([hidden, visible]);
        await raiseKeyboard("ios", "UDID", d);
        expect(d.delay).toHaveBeenCalled();
    });
});
