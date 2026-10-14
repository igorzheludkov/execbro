import { describe, it, expect } from "@jest/globals";
import { pickSimulatorByName, toNativePoint } from "../../core/ios.js";
import { decodeHtmlEntities } from "../../pro/tap.js";

describe("pickSimulatorByName", () => {
    const booted = [
        { udid: "PRO", name: "iPhone 17 Pro" },
        { udid: "MAX", name: "iPhone 17 Pro Max" }
    ];

    it("links each of two prefix-sharing simulators to its own UDID", () => {
        expect(pickSimulatorByName(booted, "iPhone 17 Pro Max")).toBe("MAX");
        expect(pickSimulatorByName(booted, "iPhone 17 Pro")).toBe("PRO");
    });

    it("refuses an ambiguous partial match rather than guessing", () => {
        expect(pickSimulatorByName(booted, "iPhone 17")).toBeNull();
        expect(pickSimulatorByName(booted, "Max")).toBe("MAX");
    });
});

describe("decodeHtmlEntities", () => {
    it("turns an escaped label back into what the screen shows", () => {
        expect(decodeHtmlEntities("Vendor &amp; Guest Registration")).toBe("Vendor & Guest Registration");
        expect(decodeHtmlEntities("a &lt;b&gt; &quot;c&quot; &#39;d&apos;")).toBe("a <b> \"c\" 'd'");
        expect(decodeHtmlEntities("R&D")).toBe("R&D");
    });
});

describe("NetworkBuffer.removeWhere", () => {
    it("drops matching rows and keeps the order of the rest", async () => {
        const { NetworkBuffer } = await import("../../core/network.js");
        const buf = new NetworkBuffer(10);
        const row = (id: string, capturedBy?: "cdp") =>
            ({ requestId: id, timestamp: new Date(), method: "GET", url: "u", headers: {}, completed: true, epoch: 1, capturedBy });
        buf.set("a", row("a", "cdp"));
        buf.set("sdk-1", row("sdk-1"));
        buf.set("b", row("b", "cdp"));
        expect(buf.removeWhere((r) => r.capturedBy === "cdp")).toBe(2);
        expect(buf.getAll({}).map((r) => r.requestId)).toEqual(["sdk-1"]);
    });
});

describe("toNativePoint", () => {
    // Points measured by hand on an iPhone 17 Pro simulator (portrait 402x874):
    // the Scroll chip at landscape (159,101) only responded at these native points.
    const app = { width: 874, height: 402 };

    it("maps device orientation 3 (ccw)", () => {
        expect(toNativePoint(159, 101, "ccw", app)).toEqual([301, 159]);
    });

    it("maps device orientation 4 (cw)", () => {
        expect(toNativePoint(235, 100, "cw", app)).toEqual([100, 639]);
    });

    it("leaves a portrait app alone", () => {
        expect(toNativePoint(10, 20, "none", { width: 402, height: 874 })).toEqual([10, 20]);
    });
});

describe("matchDeviceName", () => {
    it("lets an exact name beat a longer name containing it", async () => {
        const { matchDeviceName } = await import("../../core/state.js");
        const names = ["iPhone 17 Pro Max", "iPhone 17 Pro"];
        expect(matchDeviceName("iPhone 17 Pro", names)).toBe("iPhone 17 Pro");
        expect(matchDeviceName("iphone 17 pro max", names)).toBe("iPhone 17 Pro Max");
        expect(matchDeviceName("Max", names)).toBe("iPhone 17 Pro Max");
        expect(matchDeviceName("Pixel", names)).toBeUndefined();
    });
});
