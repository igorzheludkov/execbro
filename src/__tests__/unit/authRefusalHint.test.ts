import { describe, it, expect } from "@jest/globals";
import { authRefusalHint } from "../../core/authRefusalHint.js";

describe("authRefusalHint", () => {
    it("points a bare fetch that was refused at app_request and the captured call", () => {
        const hint = authRefusalHint("fetch('http://localhost:8092/orders').then(function(r){return r.text();})", '{"error":"Unauthorized"}');
        expect(hint).toContain('app_request({ method: "GET", url, auth: "auto" })');
        expect(hint).toContain("get_request_details");
    });
    it("reads a 403 status from an XMLHttpRequest result too", () => {
        expect(authRefusalHint("var x = new XMLHttpRequest(); x.open('GET', u); x.send(); x.status", "403")).not.toBeNull();
    });
    it("stays quiet when the expression made no HTTP call", () => {
        expect(authRefusalHint("store.getState().auth.error", '"Unauthorized"')).toBeNull();
    });
    it("stays quiet when the call succeeded", () => {
        expect(authRefusalHint("fetch(u).then(r => r.json())", '{"orders":[{"id":401}]}')).toBeNull();
    });
});
