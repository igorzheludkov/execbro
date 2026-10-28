import { describe, it, expect, beforeEach } from "@jest/globals";
import { routeNameOf, recordChromiumNavigation, chromiumNavigations, resetChromiumNavigations } from "../../core/chromiumNavigation.js";
import { handleCDPMessage } from "../../core/connection.js";

describe("routeNameOf", () => {
    it("is path plus hash", () => {
        expect(routeNameOf("http://localhost:5173/settings#billing?x=1")).toBe("/settings#billing?x=1");
        expect(routeNameOf("http://localhost:5173/cart?id=3")).toBe("/cart");
        expect(routeNameOf("data:text/html,hi")).toBe("(data: URL)");
        expect(routeNameOf("not a url")).toBeNull();
    });
});

describe("recordChromiumNavigation", () => {
    beforeEach(() => resetChromiumNavigations());

    it("records route changes and skips repeats in the same run", () => {
        recordChromiumNavigation("App", "http://x/a", 1, 100);
        recordChromiumNavigation("App", "http://x/a", 1, 200);
        recordChromiumNavigation("App", "http://x/b", 1, 300);
        recordChromiumNavigation("App", "http://x/b", 2, 400);
        expect(chromiumNavigations("App").map((n) => `${n.route}@${n.at}`)).toEqual(["/a@100", "/b@300", "/b@400"]);
    });
});

describe("handleCDPMessage navigation events", () => {
    beforeEach(() => resetChromiumNavigations());
    const device = { id: "T1", title: "App", description: "", appId: "", type: "page", webSocketDebuggerUrl: "ws://x/T1", deviceName: "App" };

    it("records main-frame navigations and in-document route changes", () => {
        handleCDPMessage({ method: "Page.frameNavigated", params: { frame: { id: "T1", url: "http://x/home" } } }, device as never);
        handleCDPMessage({ method: "Page.frameNavigated", params: { frame: { id: "F2", parentId: "T1", url: "http://ads/iframe" } } }, device as never);
        handleCDPMessage({ method: "Page.navigatedWithinDocument", params: { frameId: "T1", url: "http://x/home#/cart" } }, device as never);
        expect(chromiumNavigations("App").map((n) => n.route)).toEqual(["/home", "/home#/cart"]);
    });

    it("ignores an iframe's in-document route change", () => {
        handleCDPMessage({ method: "Page.navigatedWithinDocument", params: { frameId: "F2", url: "http://ads/iframe#/step2" } }, device as never);
        expect(chromiumNavigations("App")).toEqual([]);
    });
});
