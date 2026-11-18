process.env.EXECBRO_TEST_MODE = "1";

import { describe, it, expect, beforeEach } from "@jest/globals";

/**
 * A promise still pending when the poll budget runs out leaves a handle the agent collects later: 15 of 28 such execute_in_app results in 2026-11-04..18 were followed by a successful collect. The call did its job, so the tool must not report it as a failure. Internal callers cannot collect, so for them it stays one.
 */

const { toolRegistry } = await import("../../core/register.js");
const { registerExecutionTools } = await import("../../tools/executionTools.js");
registerExecutionTools({ registerTool: () => undefined } as never);
const { executeInApp } = await import("../../core/jsExecute.js");
const { connectedApps, pendingExecutions } = await import("../../core/state.js");

// The wrapper reports a promise, and every poll of its slot finds it pending.
function pendingApp() {
    const ws = {
        readyState: 1,
        close() {},
        send(raw: string) {
            const { id, params } = JSON.parse(raw);
            const expr: string = params?.expression ?? "";
            const result = expr.includes("return '__awaiting__'") ? "__awaiting__" : expr.includes("'__pending__'") ? "__pending__" : "ok";
            setTimeout(() => pendingExecutions.get(id)?.resolve({ success: true, result } as any), 0);
        },
    };
    connectedApps.set("8081-d1", { ws, port: 8081, platform: "ios", deviceInfo: { id: "d1", title: "App (iPhone)", deviceName: "iPhone", webSocketDebuggerUrl: "" } } as any);
}

describe("a promise still pending at the budget", () => {
    beforeEach(() => {
        connectedApps.clear();
        pendingApp();
    });

    it("is a result with a collect handle for execute_in_app", async () => {
        const r = await toolRegistry.get("execute_in_app")!.handler({ expression: "new Promise(() => {})", awaitPromise: true, timeoutMs: 100, maxResultLength: 2000 });
        expect(r.isError).toBeUndefined();
        expect(r.content[0].text).toMatch(/execute_in_app\(\{ collect: "__rn_dbg_/);
    });

    it("is still a failure for internal callers", async () => {
        const r = await executeInApp("new Promise(() => {})", true, { maxRetries: 0, autoReconnect: false, skipBootstrap: true, timeoutMs: 100 });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/did not settle/);
    });
});
