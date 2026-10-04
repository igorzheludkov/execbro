import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { startFakeSdk, HELLO } from "../helpers/fakeNativeSdk.js";

const execFileAsyncMock = jest.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>();
jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execFileAsyncMock,
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: (fn: (signal?: AbortSignal) => unknown) => fn(undefined)
}));

const { connectNativeApp } = await import("../../core/nativeConnection.js");
const { connectedApps } = await import("../../core/state.js");

let fake: Awaited<ReturnType<typeof startFakeSdk>> | null = null;

afterEach(async () => {
    for (const app of connectedApps.values()) app.ws.terminate();
    connectedApps.clear();
    await fake?.close();
    fake = null;
});

describe("connectNativeApp", () => {
    it("shares one connection between concurrent connects to the same app", async () => {
        fake = await startFakeSdk((m) => (m === "execbro.hello" ? HELLO : null));
        const port = fake.port;
        execFileAsyncMock.mockImplementation(async (_file, args) => ({ stdout: args.includes("tcp:0") ? `${port}\n` : "", stderr: "" }));

        const [a, b] = await Promise.all([
            connectNativeApp("emulator-5554", "com.example.app"),
            connectNativeApp("emulator-5554", "com.example.app")
        ]);

        expect(a === b).toBe(true);
        expect(execFileAsyncMock.mock.calls.filter(([, args]) => args.includes("tcp:0"))).toHaveLength(1);
    });
});
