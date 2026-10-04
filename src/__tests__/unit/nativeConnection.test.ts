import { describe, it, expect, afterEach } from "@jest/globals";
import { connectedApps } from "../../core/state.js";
import { openNativeSocket, nativeRequest, nativeAppKey, NativeRpcError } from "../../core/nativeConnection.js";
import { startFakeSdk, rpcError, NO_REPLY, HELLO } from "../helpers/fakeNativeSdk.js";

const target = { serial: "emulator-5554", pkg: "com.example.app", port: 0 };
let fake: Awaited<ReturnType<typeof startFakeSdk>> | null = null;

afterEach(async () => {
    for (const app of connectedApps.values()) app.ws.terminate();
    connectedApps.clear();
    await fake?.close();
    fake = null;
});

function handler(method: string, params: Record<string, unknown>): unknown {
    if (method === "execbro.hello") return HELLO;
    if (method === "state.get" && params.name === "lock") return { value: true };
    if (method === "state.get") throw rpcError("NOT_FOUND", `No state named '${String(params.name)}'`);
    if (method === "slow") return NO_REPLY;
    throw rpcError("METHOD_NOT_FOUND", method);
}

describe("openNativeSocket", () => {
    it("registers the app under its native key", async () => {
        fake = await startFakeSdk(handler);
        const app = await openNativeSocket(fake.url, { ...target, port: fake.port });
        expect(nativeAppKey("emulator-5554", "com.example.app")).toBe("native:emulator-5554:com.example.app");
        expect(connectedApps.get("native:emulator-5554:com.example.app")).toBe(app);
        expect(app.runtime).toBe("native");
        expect(app.platform).toBe("android");
        expect(app.adbSerial).toBe("emulator-5554");
        expect(app.nativePackage).toBe("com.example.app");
        expect(app.deviceInfo.deviceName).toBe("Example");
        expect(app.nativeCapabilities).toEqual(["state", "command", "navigation"]);
    });

    it("refuses an SDK speaking another protocol version and registers nothing", async () => {
        fake = await startFakeSdk((m) => (m === "execbro.hello" ? { ...HELLO, protocolVersion: 2 } : null));
        await expect(openNativeSocket(fake.url, { ...target, port: fake.port })).rejects.toThrow(/protocol 2/);
        expect(connectedApps.size).toBe(0);
    });

    it("drops the app, rejects pending calls and reports the close when the socket goes away", async () => {
        fake = await startFakeSdk(handler);
        let closed = false;
        const app = await openNativeSocket(fake.url, { ...target, port: fake.port }, () => { closed = true; });
        const pending = nativeRequest(app.ws, "slow");
        fake.dropClients();
        await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
        await new Promise((r) => setTimeout(r, 20));
        expect(connectedApps.size).toBe(0);
        expect(closed).toBe(true);
    });
    it("survives socket errors after the connection is open", async () => {
        fake = await startFakeSdk(handler);
        const app = await openNativeSocket(fake.url, { ...target, port: fake.port });
        expect(() => {
            app.ws.emit("error", new Error("ECONNRESET"));
            app.ws.emit("error", new Error("ECONNRESET"));
        }).not.toThrow();
    });
});

describe("nativeRequest", () => {
    it("resolves results and rejects errors with their code", async () => {
        fake = await startFakeSdk(handler);
        const app = await openNativeSocket(fake.url, { ...target, port: fake.port });
        await expect(nativeRequest(app.ws, "state.get", { name: "lock" })).resolves.toEqual({ value: true });
        const err = (await nativeRequest(app.ws, "state.get", { name: "nope" }).catch((e: unknown) => e)) as NativeRpcError;
        expect(err).toBeInstanceOf(NativeRpcError);
        expect(err.code).toBe("NOT_FOUND");
    });

    it("times out a call the app never answers", async () => {
        fake = await startFakeSdk(handler);
        const app = await openNativeSocket(fake.url, { ...target, port: fake.port });
        await expect(nativeRequest(app.ws, "slow", undefined, 50)).rejects.toMatchObject({ code: "TIMEOUT" });
    });
});
