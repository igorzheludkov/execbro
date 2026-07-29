import { describe, expect, it, jest } from "@jest/globals";
import { diagnoseEmptyLogs, type LogDiagnosisDeps } from "../../core/logDiagnosis.js";
import type { ConnectionCheckResult } from "../../core/types.js";
import type { LogPipelineResult } from "../../core/connection.js";

const APP = { id: "app-1" };

const conn = (over: Partial<ConnectionCheckResult> = {}): ConnectionCheckResult => ({
    connected: true,
    wasReconnected: false,
    message: null,
    ...over
});

const pipe = (over: Partial<LogPipelineResult> = {}): LogPipelineResult => ({
    ok: true,
    recovered: false,
    message: null,
    ...over
});

const deps = (
    status: ConnectionCheckResult,
    pipeline: LogPipelineResult | null,
    app: typeof APP | null = APP
): LogDiagnosisDeps<typeof APP> => ({
    checkConnection: jest.fn(async () => status),
    resolveApp: jest.fn(() => app),
    verifyPipeline: jest.fn(async () => pipeline ?? pipe())
});

describe("diagnoseEmptyLogs", () => {
    it("reports disconnected when the connection could not be established", async () => {
        const d = await diagnoseEmptyLogs(deps(conn({ connected: false, message: "[CONNECTION] gone" }), null));
        expect(d.reason).toBe("disconnected");
        expect(d.warning).toContain("[CONNECTION] gone");
        expect(d.recovered).toBe(false);
    });

    it("does not probe the pipeline when disconnected", async () => {
        const dep = deps(conn({ connected: false }), null);
        await diagnoseEmptyLogs(dep);
        expect(dep.verifyPipeline).not.toHaveBeenCalled();
    });

    it("reports no_logs_verified only after the pipeline probe succeeds", async () => {
        const d = await diagnoseEmptyLogs(deps(conn(), pipe({ ok: true, recovered: false })));
        expect(d.reason).toBe("no_logs_verified");
    });

    it("reports no_logs_unverified when no app can be resolved to probe", async () => {
        const d = await diagnoseEmptyLogs(deps(conn(), null, null));
        expect(d.reason).toBe("no_logs_unverified");
    });

    it("reports pipeline_failed when the probe does not round-trip", async () => {
        const d = await diagnoseEmptyLogs(deps(conn(), pipe({ ok: false, message: "[PIPELINE] dead" })));
        expect(d.reason).toBe("pipeline_failed");
        expect(d.warning).toContain("[PIPELINE] dead");
    });

    it("reports pipeline_recovered and flags recovered when the probe self-heals", async () => {
        const d = await diagnoseEmptyLogs(deps(conn(), pipe({ ok: true, recovered: true })));
        expect(d.reason).toBe("pipeline_recovered");
        expect(d.recovered).toBe(true);
    });

    it("reports post_reconnect when the connection was re-established", async () => {
        const d = await diagnoseEmptyLogs(deps(conn({ wasReconnected: true }), pipe()));
        expect(d.reason).toBe("post_reconnect");
    });

    it("keeps post_reconnect even when the pipeline is healthy", async () => {
        const d = await diagnoseEmptyLogs(deps(conn({ wasReconnected: true }), pipe({ ok: true })));
        expect(d.reason).toBe("post_reconnect");
    });

    it("lets pipeline_failed override post_reconnect", async () => {
        const d = await diagnoseEmptyLogs(deps(conn({ wasReconnected: true }), pipe({ ok: false })));
        expect(d.reason).toBe("pipeline_failed");
    });

    it("never returns the ambiguous legacy no_logs label", async () => {
        const cases: Array<[ConnectionCheckResult, LogPipelineResult | null, typeof APP | null]> = [
            [conn(), pipe(), APP],
            [conn(), null, null],
            [conn({ connected: false }), null, null],
            [conn({ wasReconnected: true }), pipe(), APP]
        ];
        for (const [status, pipeline, app] of cases) {
            const d = await diagnoseEmptyLogs(deps(status, pipeline, app));
            expect(d.reason).not.toBe("no_logs");
        }
    });

    it("concatenates connection and pipeline messages", async () => {
        const d = await diagnoseEmptyLogs(deps(conn({ message: "[CONNECTION] stale" }), pipe({ message: "[PIPELINE] recovered" })));
        expect(d.warning).toContain("[CONNECTION] stale");
        expect(d.warning).toContain("[PIPELINE] recovered");
    });
});
