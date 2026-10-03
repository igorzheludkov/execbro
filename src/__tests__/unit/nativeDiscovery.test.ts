import { describe, it, expect } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import { parseExecbroSockets, discoverAndConnectNativeApps } from "../../core/nativeDiscovery.js";

const PROC_NET_UNIX = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 41234 @execbro_com.ihorzheludkov.touchdisabler",
    "0000000000000000: 00000003 00000000 00000000 0001 03 41240 @execbro_com.ihorzheludkov.touchdisabler",
    "0000000000000000: 00000002 00000000 00010000 0001 01 51234 @chrome_devtools_remote",
    "0000000000000000: 00000002 00000000 00010000 0001 01 61234 @execbro_com.example.app",
    "0000000000000000: 00000002 00000000 00010000 0001 01 71234 /dev/socket/zygote"
].join("\n");

describe("parseExecbroSockets", () => {
    it("returns each SDK package once and ignores other sockets", () => {
        expect(parseExecbroSockets(PROC_NET_UNIX)).toEqual(["com.ihorzheludkov.touchdisabler", "com.example.app"]);
    });

    it("returns nothing for an empty or unreadable listing", () => {
        expect(parseExecbroSockets("")).toEqual([]);
        expect(parseExecbroSockets("cat: /proc/net/unix: Permission denied")).toEqual([]);
    });
});

describe("discoverAndConnectNativeApps", () => {
    it("does nothing, and asks nothing of adb, when adb is missing", async () => {
        let discovered = false;
        const lines = await discoverAndConnectNativeApps({
            adbAvailable: async () => false,
            discover: async () => { discovered = true; return []; }
        });
        expect(lines).toEqual([]);
        expect(discovered).toBe(false);
    });

    it("reports connected apps and connection failures per app", async () => {
        const lines = await discoverAndConnectNativeApps({
            adbAvailable: async () => true,
            discover: async () => [
                { serial: "emulator-5554", pkg: "com.good" },
                { serial: "emulator-5554", pkg: "com.bad" }
            ],
            connect: async (_serial, pkg) => {
                if (pkg === "com.bad") throw new Error("protocol 2");
                return { deviceInfo: { deviceName: "Good" } } as ConnectedApp;
            }
        });
        expect(lines).toEqual([
            "Android native (emulator-5554): connected to Good (com.good) via execbro-sdk-android",
            "Android native (emulator-5554): found com.bad but could not connect: protocol 2"
        ]);
    });
});
