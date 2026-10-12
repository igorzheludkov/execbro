/**
 * Metro closes the current debugger with `[NEW_DEBUGGER_OPENED]` when another
 * one attaches to the same app. Recognising it is what stops two auto-
 * reconnecting debuggers (execbro + execbro-dev, or execbro + React Native
 * DevTools) from evicting each other in a loop. `ws` hands the close reason
 * over as a Buffer, so that is the shape that has to match.
 */
import { isDisplacedClose } from "../../core/connection.js";

describe("isDisplacedClose", () => {
    it("matches Metro's new-debugger close reason as ws delivers it", () => {
        const reason = Buffer.from("[NEW_DEBUGGER_OPENED] New debugger opened for the same app instance");
        expect(isDisplacedClose(reason)).toBe(true);
    });

    it("does not match other closes", () => {
        expect(isDisplacedClose(Buffer.from(""))).toBe(false);
        expect(isDisplacedClose(Buffer.from("[PAGE_NOT_FOUND] Debugger page not found"))).toBe(false);
        expect(isDisplacedClose(undefined)).toBe(false);
    });
});
