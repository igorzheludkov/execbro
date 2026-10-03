import { describe, it, expect, afterEach } from "@jest/globals";
import WebSocket from "ws";
import { connectedApps } from "../../core/state.js";
import { ensureConnection } from "../../core/connection.js";
import { openNativeSocket } from "../../core/nativeConnection.js";
import { startFakeSdk, rpcError, HELLO } from "../helpers/fakeNativeSdk.js";

let fake: Awaited<ReturnType<typeof startFakeSdk>>;

afterEach(async () => {
    for (const a of connectedApps.values()) a.ws.terminate();
    connectedApps.clear();
    await fake.close();
});

describe("ensureConnection with a native app connected", () => {
    it("leaves the native app alone instead of health-checking it over CDP", async () => {
        // A CDP health check is meaningless to the SDK: it answers METHOD_NOT_FOUND or nothing,
        // and the failed check used to close the native socket right after ensure_connection reconnected it.
        fake = await startFakeSdk((method) => {
            if (method === "execbro.hello") return HELLO;
            throw rpcError("METHOD_NOT_FOUND", method);
        });
        const app = await openNativeSocket(fake.url, { serial: "emulator-5554", pkg: "com.example.app", port: fake.port });

        // Port 1 is closed: there is no Metro, so only the native app is in play.
        await ensureConnection({ port: 1, healthCheck: true });

        expect(connectedApps.get("native:emulator-5554:com.example.app")).toBe(app);
        expect(app.ws.readyState).toBe(WebSocket.OPEN);
    }, 20000);
});
