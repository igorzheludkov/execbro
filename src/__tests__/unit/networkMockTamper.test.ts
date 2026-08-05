import { describe, it, expect } from "@jest/globals";
import { runWithMocks } from "../helpers/mock-harness.js";

/**
 * Tamper runs the real request on a second, unpatched XHR and hands the app a
 * response we synthesized. The alternative — letting the app's own request fly
 * and mutating it in a load listener — is broken, and the second test here is
 * the reason: apps commonly assign xhr.onload BEFORE send(), and a property
 * handler runs ahead of any listener we could add afterwards, so the app would
 * read the untampered response. Do not "simplify" the shadow away.
 */

describe("injected interceptor — tamper", () => {
    it("issues the real request on a shadow XHR and mutates the response", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", remove: ["data.email"] }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.setRequestHeader("Authorization", "Bearer tok");
        app.send();

        // The shadow XHR is the most recently constructed instance.
        const shadow = t.lastXhr();
        expect(shadow).not.toBe(app);
        expect(shadow.method).toBe("GET");
        expect(shadow.url).toBe("https://api.example.com/me");
        expect(shadow.requestHeaders.Authorization).toBe("Bearer tok");
        expect(shadow.sendCalled).toBe(1);
        expect(app.sendCalled).toBe(0);

        shadow.status = 200;
        shadow.responseText = '{"data":{"id":1,"email":"a@b.c"}}';
        shadow.emit("load");
        t.flush();

        expect(JSON.parse(app.responseText)).toEqual({ data: { id: 1 } });
        expect(app.status).toBe(200);
    });

    // THE regression test for the ordering hazard.
    it("tampers even when the app registered onload BEFORE send", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", set: { ok: false } }]);
        const app = t.newXhr();
        const observed: string[] = [];
        app.onload = () => observed.push(app.responseText); // set BEFORE send
        app.open("GET", "https://api.example.com/me");
        app.send();

        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = '{"ok":true}';
        shadow.emit("load");
        t.flush();

        expect(observed).toHaveLength(1);
        expect(JSON.parse(observed[0])).toEqual({ ok: false });
    });

    it("the shadow request is not itself intercepted, so it reports nothing", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", set: { a: 1 } }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = "{}";
        shadow.emit("load");
        t.flush();

        // One request event (the app's), never a second for the shadow —
        // otherwise every tampered call would appear twice in the buffer.
        expect(t.events().filter((e) => e.type === "request")).toHaveLength(1);
    });

    it("overrides status while leaving the body alone", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", status: 503 }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = '{"ok":true}';
        shadow.emit("load");
        t.flush();
        expect(app.status).toBe(503);
        expect(JSON.parse(app.responseText)).toEqual({ ok: true });
    });

    it("keeps the real status when the rule does not override it", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", set: { a: 1 } }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 404;
        shadow.responseText = "{}";
        shadow.emit("load");
        t.flush();
        expect(app.status).toBe(404);
    });

    it("sets a nested path, creating intermediate objects", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", set: { "a.b.c": 7 } }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.responseText = "{}";
        shadow.status = 200;
        shadow.emit("load");
        t.flush();
        expect(JSON.parse(app.responseText)).toEqual({ a: { b: { c: 7 } } });
    });

    it("removes a nested path and leaves its siblings intact", () => {
        const t = runWithMocks([
            { id: "m1", url: "/me", mode: "tamper", remove: ["user.email", "user.missing.deep"] },
        ]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = '{"user":{"id":3,"email":"x@y.z"},"other":1}';
        shadow.emit("load");
        t.flush();
        expect(JSON.parse(app.responseText)).toEqual({ user: { id: 3 }, other: 1 });
    });

    it("bodyReplace wins over the real body without needing valid JSON", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", bodyReplace: "REPLACED" }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = "<html>";
        shadow.emit("load");
        t.flush();
        expect(app.responseText).toBe("REPLACED");
    });

    it("reports a warning and passes the body through when it is not JSON", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", remove: ["a"] }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = "<html>not json</html>";
        shadow.emit("load");
        t.flush();

        expect(app.responseText).toBe("<html>not json</html>");
        const mock = t.events().find((e) => e.type === "mock")!;
        expect(String(mock.warning)).toMatch(/not JSON/i);
    });

    it("surfaces a shadow-request failure as a network error, not a hang", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", set: { a: 1 } }]);
        const app = t.newXhr();
        const events: string[] = [];
        app.addEventListener("error", () => events.push("error"));
        app.open("GET", "https://api.example.com/me");
        app.send();
        t.lastXhr().emit("error");
        t.flush();
        expect(events).toEqual(["error"]);
        const mock = t.events().find((e) => e.type === "mock")!;
        expect(String(mock.warning)).toMatch(/shadow/i);
    });

    it("delivers only once when the shadow emits load twice", () => {
        const t = runWithMocks([{ id: "m1", url: "/me", mode: "tamper", set: { a: 1 } }]);
        const app = t.newXhr();
        app.open("GET", "https://api.example.com/me");
        app.send();
        const shadow = t.lastXhr();
        shadow.status = 200;
        shadow.responseText = "{}";
        shadow.emit("load");
        shadow.emit("load");
        t.flush();
        expect(t.events().filter((e) => e.type === "mock")).toHaveLength(1);
    });

    it("forwards the request body to the shadow", () => {
        const t = runWithMocks([{ id: "m1", url: "/orders", mode: "tamper", set: { a: 1 } }]);
        const app = t.newXhr();
        app.open("POST", "https://api.example.com/orders");
        app.send('{"qty":2}');
        expect(t.lastXhr().sentBody).toBe('{"qty":2}');
    });
});
