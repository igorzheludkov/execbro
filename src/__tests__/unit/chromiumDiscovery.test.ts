import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
    isChromiumTarget,
    isBrowserInternalTarget,
    nameChromiumTargets,
    chromiumScanPorts,
    filterDebuggableDevices,
    pickReconnectTarget,
    isChromiumListing,
    keepChromiumPages,
    selectConnectTargets,
    fetchDevices,
    isUntitledPage,
    pinChromiumName,
    __resetChromiumNames,
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

beforeEach(() => __resetChromiumNames());

describe("nameChromiumTargets", () => {
    it("names by title, suffixes collisions in url order, and stores the url as appId", () => {
        const a = target({ id: "aaa", title: "FluentTalk", url: "http://localhost:5173/index.html?window=popover" });
        const b = target({ id: "zzz", title: "FluentTalk", url: "http://localhost:5173/index.html?window=main" });
        nameChromiumTargets([a, b]);
        expect(b.deviceName).toBe("FluentTalk");
        expect(a.deviceName).toBe("FluentTalk#2");
        expect(a.appId).toBe("http://localhost:5173/index.html?window=popover");
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
    it("keeps a live window's name when its title changes", () => {
        nameChromiumTargets([target({ id: "w", title: "Inbox", url: "http://a" })]);
        const [w] = nameChromiumTargets([target({ id: "w", title: "Inbox (3)", url: "http://a" })]);
        expect(w.deviceName).toBe("Inbox");
    });

    it("a reopened window reclaims its old name, not the free plain one", () => {
        const pop = () => target({ id: "pop", title: "FluentTalk", url: "http://x/?window=popover" });
        nameChromiumTargets([pop()]);
        const first = nameChromiumTargets([pop(), target({ id: "m1", title: "FluentTalk", url: "http://x/?window=main" })]);
        expect(first.find((d) => d.id === "m1")?.deviceName).toBe("FluentTalk#2");
        // Popover gone, main reopened with a new target id.
        const [main] = nameChromiumTargets([target({ id: "m2", title: "FluentTalk", url: "http://x/?window=main" })]);
        expect(main.deviceName).toBe("FluentTalk#2");
        // The popover's name stays reserved for the popover.
        const [other] = nameChromiumTargets([target({ id: "n", title: "FluentTalk", url: "http://x/?window=other" })]);
        expect(other.deviceName).toBe("FluentTalk#3");
    });

    it("gives two same-url tabs distinct names and both reclaim them", () => {
        const mk = (a: string, b: string) => [
            target({ id: a, title: "Docs", url: "http://d" }),
            target({ id: b, title: "Docs", url: "http://d" }),
        ];
        expect(nameChromiumTargets(mk("a1", "b1")).map((d) => d.deviceName).sort()).toEqual(["Docs", "Docs#2"]);
        expect(nameChromiumTargets(mk("a2", "b2")).map((d) => d.deviceName).sort()).toEqual(["Docs", "Docs#2"]);
    });

    it("gives an untitled window a provisional name that is not pinned", () => {
        const url = "http://localhost:5173/index.html?window=main";
        const popover = () => target({ id: "p", title: "FluentTalk", url: "http://localhost:5173/index.html?window=popover" });
        nameChromiumTargets([popover()]);
        const [early] = nameChromiumTargets([target({ id: "m", title: "localhost:5173/index.html?window=main", url })]);
        expect(early.deviceName).toBe("localhost:5173/index.html?window=main");
        const later = nameChromiumTargets([popover(), target({ id: "m", title: "FluentTalk", url })]);
        expect(later.find((d) => d.id === "m")?.deviceName).toBe("FluentTalk#2");
    });

    it("keeps an untitled window's name once it was connected (pinned)", () => {
        const url = "http://localhost:5173/index.html?window=main";
        const [early] = nameChromiumTargets([target({ id: "m", title: "", url })]);
        pinChromiumName(early);
        const [later] = nameChromiumTargets([target({ id: "m", title: "FluentTalk", url })]);
        expect(later.deviceName).toBe(early.deviceName);
    });
});

describe("isUntitledPage", () => {
    it("treats an empty title and the scheme-less url as placeholders", () => {
        expect(isUntitledPage(target({ title: "", url: "http://localhost:5173/" }))).toBe(true);
        expect(isUntitledPage(target({ title: "localhost:5173/", url: "http://localhost:5173/" }))).toBe(true);
        expect(isUntitledPage(target({ title: "FluentTalk", url: "http://localhost:5173/" }))).toBe(false);
    });
});

describe("fetchDevices title grace", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });
    const listing = (title: string) => [{ id: "g", type: "page", title, url: "http://localhost:5173/", description: "", webSocketDebuggerUrl: "ws://x/g" }];
    function serve(...bodies: unknown[]) {
        let i = 0;
        const calls = { n: 0 };
        globalThis.fetch = (async () => {
            calls.n++;
            return { ok: true, json: async () => bodies[Math.min(i++, bodies.length - 1)] };
        }) as unknown as typeof fetch;
        return calls;
    }

    it("waits for a new window's title before naming it", async () => {
        serve(listing(""), listing("localhost:5173/"), listing("Vite App"));
        const [d] = await fetchDevices(9999, 1000);
        expect(d.deviceName).toBe("Vite App");
    });

    it("gives up after the grace and names it by url", async () => {
        serve(listing(""));
        const [d] = await fetchDevices(9999, 150);
        expect(d.deviceName).toBe("http://localhost:5173/");
    });

    it("does not wait for a Metro listing or an already pinned window", async () => {
        const calls = serve([{ id: "he", type: "node", title: "Hermes React Native", description: "", deviceName: "Pixel", webSocketDebuggerUrl: "ws://x" }]);
        await fetchDevices(9998, 1000);
        expect(calls.n).toBe(1);
        const [d] = nameChromiumTargets(listing("") as unknown as DeviceInfo[]);
        pinChromiumName(d);
        const again = serve(listing(""));
        await fetchDevices(9999, 1000);
        expect(again.n).toBe(1);
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

describe("isChromiumListing / keepChromiumPages (a port is Chromium by what it lists)", () => {
    it("recognises a Chromium endpoint on any port number, including the RN range", () => {
        expect(isChromiumListing([target({ id: "p", title: "FluentTalk", url: "http://localhost:5173/" })])).toBe(true);
        expect(isChromiumListing(RN_TARGETS)).toBe(false);
        expect(isChromiumListing([])).toBe(false);
    });

    it("keeps only real pages on a Chromium endpoint, so an unknown type never connects as android", () => {
        const listing = [
            target({ id: "p", title: "App", url: "http://localhost:5173/" }),
            target({ id: "o", type: "other", title: "Something", url: "" }),
            target({ id: "x", type: "assistive_technology", title: "AT", url: "" }),
        ];
        expect(keepChromiumPages(listing).map((d) => d.id)).toEqual(["p"]);
    });

    it("leaves a Metro listing untouched, whatever its target types", () => {
        const odd = target({ id: "n", type: "something-new", title: "Hermes React Native", deviceName: "Pixel" });
        expect(keepChromiumPages([...RN_TARGETS, odd])).toHaveLength(4);
    });
});

describe("selectConnectTargets (connect_metro)", () => {
    const tabs = nameChromiumTargets([
        target({ id: "t1", title: "Docs", url: "http://a" }),
        target({ id: "t2", title: "Mail", url: "http://b" }),
    ]);

    it("refuses to connect every tab of a browser when no device is named", () => {
        const r = selectConnectTargets(tabs, undefined);
        expect("error" in r).toBe(true);
        if ("error" in r) {
            expect(r.error).toContain("Docs");
            expect(r.error).toContain("Mail");
            expect(r.error).toContain("device");
        }
    });

    it("connects the one named tab", () => {
        const r = selectConnectTargets(tabs, "mail");
        expect("targets" in r && r.targets.map((d) => d.id)).toEqual(["t2"]);
    });

    it("connects a tab named by a substring of its page url, as every other tool resolves it", () => {
        const r = selectConnectTargets(tabs, "http://b");
        expect("targets" in r && r.targets.map((d) => d.id)).toEqual(["t2"]);
    });

    it("connects a lone Chromium target without a device name", () => {
        const r = selectConnectTargets([tabs[0]], undefined);
        expect("targets" in r && r.targets).toHaveLength(1);
    });

    it("keeps Metro's connect-everything behaviour", () => {
        const r = selectConnectTargets(RN_TARGETS, undefined);
        expect("targets" in r && r.targets).toHaveLength(3);
    });

    it("names what is available when the filter matches nothing", () => {
        const r = selectConnectTargets(tabs, "nomatch");
        expect("error" in r && r.error).toContain("Available: Docs, Mail");
    });
});
