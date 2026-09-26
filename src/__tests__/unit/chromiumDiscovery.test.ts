import { describe, it, expect } from "@jest/globals";
import {
    isChromiumTarget,
    isBrowserInternalTarget,
    nameChromiumTargets,
    chromiumScanPorts,
    filterDebuggableDevices,
    pickReconnectTarget,
} from "../../core/metro.js";
import type { DeviceInfo } from "../../core/types.js";

function target(overrides: Partial<DeviceInfo>): DeviceInfo {
    return {
        id: "id",
        title: "",
        description: "",
        appId: "",
        type: "page",
        webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/id",
        deviceName: "",
        ...overrides,
    } as DeviceInfo;
}

// The seven targets a real Chrome 153 exposed with one tab open, plus a DevTools window.
const CHROME_TARGETS: DeviceInfo[] = [
    target({ id: "p1", title: "Vite App", url: "http://localhost:5173/" }),
    target({ id: "b1", type: "background_page", title: "Ext A", url: "chrome-extension://aaa/bg.html" }),
    target({ id: "b2", type: "background_page", title: "Ext B", url: "chrome-extension://bbb/bg.html" }),
    target({ id: "s1", type: "service_worker", title: "SW A", url: "chrome-extension://aaa/sw.js" }),
    target({ id: "s2", type: "service_worker", title: "SW B", url: "chrome-extension://bbb/sw.js" }),
    target({ id: "u1", type: "browser_ui", title: "Omnibox", url: "chrome://omnibox-popup.top-chrome/" }),
    target({ id: "u2", type: "browser_ui", title: "Omnibox 2", url: "chrome://omnibox-popup.top-chrome/" }),
    target({ id: "d1", title: "DevTools", url: "devtools://devtools/bundled/devtools_app.html" }),
];

const RN_TARGETS: DeviceInfo[] = [
    target({ id: "bl", type: "node", title: "com.app (iPhone)", description: "React Native Bridgeless [C++ (Hermes)]", deviceName: "iPhone 17" }),
    target({ id: "he", type: "node", title: "Hermes React Native", deviceName: "Pixel" }),
    target({ id: "re", type: "node", title: "Reanimated Runtime", deviceName: "Pixel" }),
];

describe("isChromiumTarget", () => {
    it("accepts only the real page out of a full Chrome listing", () => {
        expect(CHROME_TARGETS.filter(isChromiumTarget).map((d) => d.id)).toEqual(["p1"]);
    });

    it("rejects every React Native target", () => {
        expect(RN_TARGETS.some(isChromiumTarget)).toBe(false);
    });

    it("rejects a page whose title or description says React Native", () => {
        expect(isChromiumTarget(target({ title: "React Native Experimental", url: "http://x" }))).toBe(false);
        expect(isChromiumTarget(target({ description: "React Native Bridgeless", url: "http://x" }))).toBe(false);
    });
});

describe("isBrowserInternalTarget", () => {
    it("flags extension, service-worker, browser_ui and devtools targets", () => {
        expect(CHROME_TARGETS.filter(isBrowserInternalTarget).map((d) => d.id))
            .toEqual(["b1", "b2", "s1", "s2", "u1", "u2", "d1"]);
    });

    it("never flags a Metro target, even with an unknown type", () => {
        expect(RN_TARGETS.some(isBrowserInternalTarget)).toBe(false);
        expect(isBrowserInternalTarget(target({ type: "something-new", title: "Hermes React Native" }))).toBe(false);
    });
});

describe("nameChromiumTargets", () => {
    it("names by title, suffixes collisions in target-id order, and stores the url as appId", () => {
        const a = target({ id: "zzz", title: "FluentTalk", url: "http://localhost:5173/#/popover" });
        const b = target({ id: "aaa", title: "FluentTalk", url: "http://localhost:5173/#/settings" });
        nameChromiumTargets([a, b]);
        expect(b.deviceName).toBe("FluentTalk");
        expect(a.deviceName).toBe("FluentTalk#2");
        expect(a.appId).toBe("http://localhost:5173/#/popover");
    });

    it("gives the same names regardless of listing order", () => {
        const mk = () => [
            target({ id: "zzz", title: "W", url: "http://a" }),
            target({ id: "aaa", title: "W", url: "http://b" }),
        ];
        const forward = nameChromiumTargets(mk()).map((d) => `${d.id}=${d.deviceName}`).sort();
        const reversed = nameChromiumTargets(mk().reverse()).map((d) => `${d.id}=${d.deviceName}`).sort();
        expect(forward).toEqual(reversed);
    });

    it("falls back to the url when the title is empty, and leaves RN targets untouched", () => {
        const untitled = target({ id: "x", title: "", url: "http://localhost:3000/" });
        const rn = { ...RN_TARGETS[0] };
        nameChromiumTargets([untitled, rn]);
        expect(untitled.deviceName).toBe("http://localhost:3000/");
        expect(rn.deviceName).toBe("iPhone 17");
    });
});

describe("nameChromiumTargets across fetches", () => {
    it("keeps a named window's name when a same-titled window with a lower id appears", () => {
        const first = nameChromiumTargets([target({ id: "m-connected", title: "Stable", url: "http://a" })]);
        expect(first[0].deviceName).toBe("Stable");
        // Next fetch: a new window whose id sorts BEFORE the connected one.
        const second = nameChromiumTargets([
            target({ id: "m-connected", title: "Stable", url: "http://a" }),
            target({ id: "a-newcomer", title: "Stable", url: "http://b" }),
        ]);
        expect(second.find((d) => d.id === "m-connected")?.deviceName).toBe("Stable");
        expect(second.find((d) => d.id === "a-newcomer")?.deviceName).toBe("Stable#2");
    });
});

describe("filterDebuggableDevices with chromium targets", () => {
    it("keeps two same-titled windows apart once named", () => {
        const devices = nameChromiumTargets([
            target({ id: "a", title: "W", url: "http://a" }),
            target({ id: "b", title: "W", url: "http://b" }),
        ]);
        expect(filterDebuggableDevices(devices)).toHaveLength(2);
    });
});

describe("chromiumScanPorts", () => {
    it("lists 9222 as discover-only by default", () => {
        expect(chromiumScanPorts({})).toEqual([{ port: 9222, autoConnect: false }]);
    });

    it("auto-connects configured ports, including 9222 when named", () => {
        expect(chromiumScanPorts({ EXECBRO_CHROMIUM_PORTS: "9333,9222" })).toEqual([
            { port: 9333, autoConnect: true },
            { port: 9222, autoConnect: true },
        ]);
    });

    it("ignores malformed entries instead of throwing", () => {
        expect(chromiumScanPorts({ EXECBRO_CHROMIUM_PORTS: "abc, 9223,,70000,0,9223" })).toEqual([
            { port: 9223, autoConnect: true },
            { port: 9222, autoConnect: false },
        ]);
    });
});

describe("pickReconnectTarget", () => {
    const tabA = target({ id: "a", title: "App", url: "http://localhost:5173/" });
    const tabB = target({ id: "b", title: "Other", url: "http://example.test/" });

    it("reattaches to the same target id when it is still there", () => {
        expect(pickReconnectTarget([tabB, tabA], tabA)?.id).toBe("a");
    });

    it("never falls back to another tab when the chromium target it had is gone", () => {
        // Falling back would attach to, and inject the interceptor into, a page nobody chose.
        expect(pickReconnectTarget([tabB], tabA)).toBeNull();
    });

    it("keeps the RN fallback to the main device when the id changed", () => {
        const oldRn = target({ id: "old", type: "node", title: "Hermes React Native", deviceName: "Pixel" });
        expect(pickReconnectTarget([RN_TARGETS[1]], oldRn)?.id).toBe("he");
    });
});
