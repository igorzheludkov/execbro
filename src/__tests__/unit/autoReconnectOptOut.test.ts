import { jest } from "@jest/globals";

/**
 * `executeInApp`'s outer scan-and-retry block used to run on every transport
 * failure, ignoring `options.autoReconnect` entirely — only the inner loop read
 * it. Background callers that explicitly asked for one attempt got an endless
 * reconnect storm instead: in one production week, 2192 of 2233
 * `_auto_reconnect` failures came from the SDK mirror poller, 2093 of them from
 * a single install polling a dead simulator overnight.
 *
 * The reconnect attempt is observed through `scanMetroPorts` — the first thing
 * `attemptQuickReconnect` calls. Mocking metro.js is also what keeps this test
 * off the developer's real localhost ports, which is why it does not drive the
 * real socket path.
 */

const scanMetroPorts = jest.fn<any>(async () => [8081]);
// No device comes back, so attemptQuickReconnect reports failure without ever
// opening a socket. Having been called at all is the signal under test.
const fetchDevices = jest.fn<any>(async () => []);
const selectMainDevice = jest.fn<any>(() => null);
const filterDebuggableDevices = jest.fn<any>((devices: any) => devices);

jest.unstable_mockModule("../../core/metro.js", () => ({
    scanMetroPorts,
    fetchDevices,
    selectMainDevice,
    filterDebuggableDevices,
}));

const { executeInApp, markConnectionEstablished } = await import("../../core/jsExecute.js");
const { connectedApps } = await import("../../core/state.js");

describe("executeInApp and options.autoReconnect", () => {
    beforeEach(() => {
        scanMetroPorts.mockClear();
        connectedApps.clear();
        // Mid-session drop, not "Metro never came up": without this the
        // no_apps/never-connected early return short-circuits before the
        // reconnect block either test is aiming at.
        markConnectionEstablished();
    });

    it("does not reconnect or retry a transport failure when autoReconnect is false", async () => {
        const result = await executeInApp("1", false, {
            maxRetries: 0,
            autoReconnect: false,
            originatingToolName: "_sdk_mirror",
        });

        expect(scanMetroPorts).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        // The original error, not a "reconnect_attempted:"-prefixed rewrite.
        expect(result.error).toBe("No apps connected. Run 'scan_metro' first.");
    });

    // The regression guard that matters: the opt-out must stay opt-in-by-absence.
    it("still reconnects and reports the attempt when the option is absent", async () => {
        const result = await executeInApp("1", false, { maxRetries: 0, originatingToolName: "tap" });

        expect(scanMetroPorts).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/^reconnect_attempted: /);
    });
});
