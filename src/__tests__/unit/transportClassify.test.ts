import { describe, expect, it } from "@jest/globals";
import { jest } from "@jest/globals";
import { classifyTransportError, isEvalTimeoutOnLiveSocket, classifyWithLivenessProbe, isTargetStillAdvertised } from "../../core/jsExecute.js";

// A "took too long" on a socket that is still OPEN is ambiguous: either the
// expression really was slow, or the CDP target went stale while the
// device-level socket kept answering pings. Only these cases are worth paying
// for a probe to disambiguate.
describe("isEvalTimeoutOnLiveSocket", () => {
    const timeoutMsg = (ws: string) =>
        `Timeout: Expression took too long to evaluate.\n\nConnection state: ws=${ws}, device="iPhone"`;

    it("is true for a server-timer timeout on an open socket", () => {
        expect(isEvalTimeoutOnLiveSocket(timeoutMsg("OPEN"), "server-timer")).toBe(true);
    });

    it("is false when the socket was closed (already a transport error)", () => {
        expect(isEvalTimeoutOnLiveSocket(timeoutMsg("CLOSED"), "server-timer")).toBe(false);
    });

    it("is false for errors that did not come from the server timer", () => {
        expect(isEvalTimeoutOnLiveSocket(timeoutMsg("OPEN"), "cdp")).toBe(false);
    });

    it("is false for unrelated failures", () => {
        expect(isEvalTimeoutOnLiveSocket("ReferenceError: x is not defined", "logical")).toBe(false);
    });
});

// The probe-backed upgrade lives behind an injectable seam so this can be
// exercised without a real socket. Driving it through executeInApp instead
// would reach attemptQuickReconnect -> scanMetroPorts(), which scans real
// localhost ports and would latch onto whatever Metro the developer has running.
describe("classifyWithLivenessProbe", () => {
    const timeoutMsg = (ws: string) =>
        `Timeout: Expression took too long to evaluate.\n\nConnection state: ws=${ws}, device="iPhone"`;
    const fakeApp = { ws: {}, port: 8081, deviceInfo: { id: "page-1" } } as unknown as Parameters<typeof classifyWithLivenessProbe>[2];
    const listed = async () => true;
    const gone = async () => false;

    it("keeps a ws=OPEN timeout logical when the probe answers", async () => {
        const probe = jest.fn(async () => true);
        const result = await classifyWithLivenessProbe(timeoutMsg("OPEN"), "server-timer", fakeApp, probe, gone);
        expect(result).toEqual({ kind: "logical" });
        expect(probe).toHaveBeenCalledTimes(1);
    });

    // The case that bit us on-device: a 15s busy loop silences the probe just
    // like a dead context would. Metro still lists the page, so this must stay
    // logical — upgrading it triggers a retry that re-runs the expression.
    it("keeps a blocked JS thread logical while Metro still lists the target", async () => {
        const probe = jest.fn(async () => false);
        const result = await classifyWithLivenessProbe(timeoutMsg("OPEN"), "server-timer", fakeApp, probe, listed);
        expect(result).toEqual({ kind: "logical" });
    });

    it("upgrades to stale_target only when the probe is silent AND the target is gone", async () => {
        const probe = jest.fn(async () => false);
        const result = await classifyWithLivenessProbe(timeoutMsg("OPEN"), "server-timer", fakeApp, probe, gone);
        expect(result).toEqual({ kind: "transport", pattern: "stale_target" });
    });

    it("does not spend a probe when the socket was already closed", async () => {
        const probe = jest.fn(async () => false);
        const result = await classifyWithLivenessProbe(timeoutMsg("CLOSED"), "server-timer", fakeApp, probe, gone);
        expect(result).toMatchObject({ kind: "transport", pattern: "ws_closed" });
        expect(probe).not.toHaveBeenCalled();
    });

    it("does not spend a probe on unrelated logical errors", async () => {
        const probe = jest.fn(async () => false);
        const result = await classifyWithLivenessProbe("ReferenceError: x", "logical", fakeApp, probe, gone);
        expect(result).toEqual({ kind: "logical" });
        expect(probe).not.toHaveBeenCalled();
    });

    it("stays logical when there is no app to probe", async () => {
        const probe = jest.fn(async () => false);
        const result = await classifyWithLivenessProbe(timeoutMsg("OPEN"), "server-timer", null, probe, gone);
        expect(result).toEqual({ kind: "logical" });
        expect(probe).not.toHaveBeenCalled();
    });
});

describe("isTargetStillAdvertised", () => {
    const app = { port: 8081, deviceInfo: { id: "page-1" } };

    it("is true when Metro still lists our page id", async () => {
        const fetchTargets = async () => ([{ id: "page-1" }, { id: "page-2" }] as never);
        expect(await isTargetStillAdvertised(app, fetchTargets)).toBe(true);
    });

    it("is false when Metro lists other pages but not ours", async () => {
        const fetchTargets = async () => ([{ id: "page-9" }] as never);
        expect(await isTargetStillAdvertised(app, fetchTargets)).toBe(false);
    });

    // fetchDevices returns [] on any network error. Treating that as "gone"
    // would let a Metro blip trigger a reconnect that re-runs the expression.
    it("is true when the target list comes back empty", async () => {
        const fetchTargets = async () => ([] as never);
        expect(await isTargetStillAdvertised(app, fetchTargets)).toBe(true);
    });

    it("is true when we have no page id to compare", async () => {
        const fetchTargets = async () => ([{ id: "page-9" }] as never);
        expect(await isTargetStillAdvertised({ port: 8081, deviceInfo: {} }, fetchTargets)).toBe(true);
    });
});

describe("classifyTransportError — positive cases", () => {
    it("matches 'No apps connected'", () => {
        expect(classifyTransportError("No apps connected. Run 'scan_metro' first.", "logical")).toMatchObject({
            kind: "transport",
            pattern: "no_apps",
        });
    });
    it("matches ECONNRESET", () => {
        expect(classifyTransportError("read ECONNRESET", "logical")).toMatchObject({
            kind: "transport",
            pattern: "ws_closed",
        });
    });
    it("matches WebSocket-not-open text from current wrapper", () => {
        expect(classifyTransportError("WebSocket connection is not open.", "logical")).toMatchObject({
            kind: "transport",
            pattern: "ws_closed",
        });
    });
    it("matches 'target closed' wasThrown payload", () => {
        expect(classifyTransportError("Error: target closed", "cdp")).toMatchObject({
            kind: "transport",
            pattern: "target_closed",
        });
    });
    it("matches 'Inspector detached'", () => {
        expect(classifyTransportError("Inspector detached from the page", "cdp")).toMatchObject({
            kind: "transport",
            pattern: "target_closed",
        });
    });
});

describe("classifyTransportError — negative cases (must NOT auto-retry)", () => {
    it("does NOT match server-side timer text", () => {
        const serverTimerMsg = "Timeout: Expression took too long to evaluate.\n\nConnection state: ws=OPEN...";
        expect(classifyTransportError(serverTimerMsg, "server-timer")).toEqual({ kind: "logical" });
    });
    // Backstop for the race where our timer fires before the socket's close
    // handler has failed the in-flight call. A timer expiry is only "logical"
    // if the transport was actually alive when it fired.
    it("DOES match server-timer text when the socket was already closed", () => {
        const closedMsg = "Timeout: Expression took too long to evaluate.\n\nConnection state: ws=CLOSED, device=\"iPhone\"";
        expect(classifyTransportError(closedMsg, "server-timer")).toMatchObject({
            kind: "transport",
            pattern: "ws_closed",
        });
    });

    // "took too long" on a live socket is a slow expression, not a dead
    // transport — the 1s ping/pong keepalive terminates genuinely dead sockets
    // within ~2s, so anything still OPEN after a multi-second timeout had a
    // working transport the whole time. Retrying it just burns the timeout again.
    it("does NOT match an eval-too-long message while the socket is alive", () => {
        expect(classifyTransportError("Expression took too long to evaluate", "cdp")).toEqual({
            kind: "logical",
        });
    });

    it("does NOT match 'no component matched'", () => {
        expect(classifyTransportError("No component matched pattern Foo", "logical")).toEqual({ kind: "logical" });
    });
    it("does NOT match Hermes ReferenceError", () => {
        expect(classifyTransportError("ReferenceError: __FOO__ is not defined", "logical")).toEqual({
            kind: "logical",
        });
    });
    it("does NOT match an expression that threw", () => {
        expect(classifyTransportError("Uncaught TypeError: Cannot read property 'x' of undefined", "logical")).toEqual({
            kind: "logical",
        });
    });
});
