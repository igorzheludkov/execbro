process.env.EXECBRO_TEST_MODE = "1";

import { describe, it, expect, beforeEach } from "@jest/globals";

// Missing or unusable required arguments refused with no kind, so they could not be counted as bad_arguments.

const { toolRegistry } = await import("../../core/register.js");
const { registerNetworkTools } = await import("../../tools/networkTools.js");
const { registerLogTools } = await import("../../tools/logTools.js");
const { registerMetaTools } = await import("../../tools/metaTools.js");
const stub = { registerTool: () => undefined } as never;
registerNetworkTools(stub);
registerLogTools(stub);
registerMetaTools(stub, { devMode: false, httpMode: false });
const { connectedApps } = await import("../../core/state.js");

const call = (tool: string, args: Record<string, unknown>) => toolRegistry.get(tool)!.handler(args);

describe("missing required arguments are bad_arguments", () => {
    beforeEach(() => {
        connectedApps.clear();
        connectedApps.set("8081-d1", {
            ws: { readyState: 1, send() {}, close() {} },
            port: 8081,
            platform: "ios",
            deviceInfo: { id: "d1", title: "App (iPhone)", deviceName: "iPhone", webSocketDebuggerUrl: "" },
        } as any);
    });

    it.each([
        ["search_network", {}],
        ["search_logs", {}],
        ["network_mock", { action: "remove" }],
        ["network_mock", { action: "add" }],
    ])("%s %j", async (tool, args) => {
        await expect(call(tool, args)).rejects.toMatchObject({ name: "UserInputError", kind: "bad_arguments" });
    });

    it("get_usage_guide with an unknown topic", async () => {
        const r = await call("get_usage_guide", { topic: "nope" });
        expect(r.isError).toBe(true);
        expect(r._failureKind).toBe("bad_arguments");
    });
});
