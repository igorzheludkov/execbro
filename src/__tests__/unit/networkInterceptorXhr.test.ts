import { describe, it, expect } from "@jest/globals";
import vm from "node:vm";
import { NetworkBuffer } from "../../core/network.js";
import {
    getInterceptorScript,
    applyInterceptedEvent,
    isInterceptorEvent,
    REQUEST_BODY_CAP,
    RESPONSE_BODY_CAP,
} from "../../core/networkInterceptor.js";

/**
 * The interceptor is a string of JS that only ever runs inside the app's JS
 * context, so asserting on its source text proves nothing about its behaviour.
 * These tests run it for real in a `vm` context against a fake XMLHttpRequest
 * shaped like React Native's, and read back the `__RN_NET__:` lines it emits.
 */

interface Sandbox {
    console: { debug: (s: string) => void };
    setTimeout: typeof setTimeout;
    __debugLines: string[];
    XMLHttpRequest?: unknown;
    fetch?: unknown;
    FileReader?: unknown;
    Blob?: unknown;
    [key: string]: unknown;
}

interface FakeXHR {
    listeners: Record<string, Array<() => void>>;
    method: string;
    url: string;
    sentBody: unknown;
    requestHeaders: Record<string, string>;
    responseType: string;
    responseText: string;
    response: unknown;
    responseURL: string;
    status: number;
    statusText: string;
    rawResponseHeaders: string;
    open(method: string, url: string): void;
    setRequestHeader(name: string, value: string): void;
    send(body?: unknown): void;
    addEventListener(type: string, fn: () => void): void;
    getAllResponseHeaders(): string;
    emit(type: string): void;
}

/**
 * A fresh class per sandbox. The interceptor patches `XMLHttpRequest.prototype`
 * in place, so a shared class would carry the first test's patch — and its
 * closure over the first test's console — into every later context.
 */
function makeFakeXhrClass(): new () => FakeXHR {
    return class FakeXHRImpl implements FakeXHR {
        listeners: Record<string, Array<() => void>> = {};
        method = "";
        url = "";
        sentBody: unknown = undefined;
        requestHeaders: Record<string, string> = {};
        responseType = "";
        responseText = "";
        response: unknown = undefined;
        responseURL = "";
        status = 0;
        statusText = "";
        rawResponseHeaders = "";

        open(method: string, url: string): void {
            this.method = method;
            this.url = url;
        }

        setRequestHeader(name: string, value: string): void {
            this.requestHeaders[name] = value;
        }

        send(body?: unknown): void {
            this.sentBody = body;
        }

        addEventListener(type: string, fn: () => void): void {
            (this.listeners[type] ||= []).push(fn);
        }

        getAllResponseHeaders(): string {
            return this.rawResponseHeaders;
        }

        emit(type: string): void {
            for (const fn of this.listeners[type] ?? []) fn();
        }
    };
}

interface RunOptions {
    withXhr?: boolean;
    withFetch?: boolean;
    extras?: Record<string, unknown>;
}

function runInterceptor(options: RunOptions = {}): {
    sandbox: Sandbox & Record<string, unknown>;
    events: () => Array<Record<string, unknown>>;
} {
    const { withXhr = true, withFetch = false, extras = {} } = options;

    const lines: string[] = [];
    const sandbox: Sandbox = {
        console: { debug: (s: string) => lines.push(s) },
        setTimeout: ((fn: () => void) => {
            fn();
            return 0;
        }) as unknown as typeof setTimeout,
        __debugLines: lines,
        ...extras,
    };
    if (withXhr) sandbox.XMLHttpRequest = makeFakeXhrClass();
    if (withFetch) {
        sandbox.fetch = (_input: unknown, _init?: unknown) =>
            Promise.resolve({ status: 200, statusText: "OK" });
    }

    vm.createContext(sandbox);
    vm.runInContext(getInterceptorScript(), sandbox);

    return {
        sandbox: sandbox as Sandbox & Record<string, unknown>,
        events: () =>
            lines
                .map((l) => isInterceptorEvent([{ type: "string", value: l }]))
                .filter((j): j is string => j !== null)
                .map((j) => JSON.parse(j) as Record<string, unknown>),
    };
}

function newXhr(sandbox: Record<string, unknown>): FakeXHR {
    const Ctor = sandbox.XMLHttpRequest as new () => FakeXHR;
    return new Ctor();
}

describe("injected interceptor — XHR capture", () => {
    it("reports an axios-shaped POST with headers and body", () => {
        const { sandbox, events } = runInterceptor();

        const xhr = newXhr(sandbox);
        xhr.open("post", "https://api.example.com/orders");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", "Bearer tok");
        xhr.send('{"qty":2}');

        const request = events().find((e) => e.type === "request");
        expect(request).toBeDefined();
        expect(request!.method).toBe("POST"); // normalized
        expect(request!.url).toBe("https://api.example.com/orders");
        expect(request!.headers).toEqual({
            "Content-Type": "application/json",
            Authorization: "Bearer tok",
        });
        expect(request!.body).toBe('{"qty":2}');
    });

    it("passes through to the original open/send so the request still happens", () => {
        const { sandbox } = runInterceptor();

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/ping");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.send("payload");

        // The fake's own bookkeeping only fills in if the originals ran.
        expect(xhr.method).toBe("GET");
        expect(xhr.url).toBe("https://api.example.com/ping");
        expect(xhr.sentBody).toBe("payload");
        expect(xhr.requestHeaders).toEqual({ Accept: "application/json" });
    });

    it("reports the response with status, headers, mime type and body", () => {
        const { sandbox, events } = runInterceptor();

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/users");
        xhr.send();

        xhr.status = 200;
        xhr.statusText = "OK";
        xhr.responseText = '{"users":[]}';
        xhr.rawResponseHeaders =
            "content-type: application/json; charset=utf-8\r\ncontent-length: 12\r\n";
        xhr.emit("load");

        const response = events().find((e) => e.type === "response");
        expect(response).toBeDefined();
        expect(response!.status).toBe(200);
        expect(response!.statusText).toBe("OK");
        expect(response!.body).toBe('{"users":[]}');
        expect(response!.mimeType).toBe("application/json; charset=utf-8");
        expect(response!.contentLength).toBe(12);
        expect(response!.responseHeaders).toEqual({
            "content-type": "application/json; charset=utf-8",
            "content-length": "12",
        });
    });

    it("reports the post-redirect URL only when it differs", () => {
        const { sandbox, events } = runInterceptor();

        const same = newXhr(sandbox);
        same.open("GET", "https://a.example.com/x");
        same.send();
        same.responseURL = "https://a.example.com/x";
        same.emit("load");

        const redirected = newXhr(sandbox);
        redirected.open("GET", "https://b.example.com/y");
        redirected.send();
        redirected.responseURL = "https://b.example.com/y-final";
        redirected.emit("load");

        const responses = events().filter((e) => e.type === "response");
        expect(responses).toHaveLength(2);
        expect(responses[0].url).toBeUndefined();
        expect(responses[1].url).toBe("https://b.example.com/y-final");
    });

    it("maps error, abort and timeout to a single terminal error event", () => {
        for (const [evt, expected] of [
            ["error", "Network request failed"],
            ["abort", "Request aborted"],
            ["timeout", "Request timed out"],
        ] as const) {
            const { sandbox, events } = runInterceptor();
            const xhr = newXhr(sandbox);
            xhr.open("GET", "https://api.example.com/fail");
            xhr.send();
            xhr.emit(evt);
            // A second terminal event must not produce a second report.
            xhr.emit("load");

            const errors = events().filter((e) => e.type === "error");
            expect(errors).toHaveLength(1);
            expect(errors[0].error).toBe(expected);
            expect(events().filter((e) => e.type === "response")).toHaveLength(0);
        }
    });

    it("caps request and response bodies with an explicit marker", () => {
        const { sandbox, events } = runInterceptor();

        const xhr = newXhr(sandbox);
        xhr.open("POST", "https://api.example.com/upload");
        xhr.send("q".repeat(REQUEST_BODY_CAP + 500));

        xhr.responseText = "r".repeat(RESPONSE_BODY_CAP + 700);
        xhr.emit("load");

        const request = events().find((e) => e.type === "request")!;
        const response = events().find((e) => e.type === "response")!;

        expect(String(request.body)).toMatch(/\.\.\. \[truncated 500 bytes\]$/);
        expect(String(request.body).length).toBe(
            REQUEST_BODY_CAP + "... [truncated 500 bytes]".length
        );
        expect(String(response.body)).toMatch(/\.\.\. \[truncated 700 bytes\]$/);
    });

    it("summarizes binary bodies instead of serializing them", () => {
        const { sandbox, events } = runInterceptor();

        const xhr = newXhr(sandbox);
        xhr.open("POST", "https://api.example.com/blob");
        xhr.send(new ArrayBuffer(2048));

        xhr.responseType = "arraybuffer";
        xhr.response = new ArrayBuffer(4096);
        xhr.emit("load");

        expect(events().find((e) => e.type === "request")!.body).toBe(
            "[binary body, 2048 bytes]"
        );
        expect(events().find((e) => e.type === "response")!.body).toBe(
            "[binary response, 4096 bytes]"
        );
    });

    it("stringifies a responseType=json response", () => {
        const { sandbox, events } = runInterceptor();

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/j");
        xhr.send();
        xhr.responseType = "json";
        xhr.response = { ok: true };
        xhr.emit("load");

        expect(events().find((e) => e.type === "response")!.body).toBe('{"ok":true}');
    });

    it("reads a textual blob response out of band and emits a body event", () => {
        class FakeBlob {
            constructor(public text: string) {}
        }
        let readerInstance: { onload?: () => void; result?: string } | null = null;
        class FakeFileReader {
            onload?: () => void;
            result?: string;
            constructor() {
                readerInstance = this;
            }
            readAsText(blob: FakeBlob): void {
                this.result = blob.text;
                // RN's FileReader is async; the interceptor must not assume otherwise.
                queueMicrotask(() => this.onload?.());
            }
        }

        const { sandbox, events } = runInterceptor({
            extras: { Blob: FakeBlob, FileReader: FakeFileReader, queueMicrotask },
        });

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/fetched");
        xhr.send();
        xhr.responseType = "blob";
        xhr.rawResponseHeaders = "content-type: application/json\r\n";
        xhr.response = new FakeBlob('{"via":"blob"}');
        xhr.emit("load");

        // The response event carries no body — the blob has not been read yet.
        const response = events().find((e) => e.type === "response")!;
        expect(response.body).toBeUndefined();
        expect(readerInstance).not.toBeNull();

        readerInstance!.onload?.();

        const body = events().find((e) => e.type === "body");
        expect(body).toBeDefined();
        expect(body!.body).toBe('{"via":"blob"}');
        expect(body!.id).toBe(response.id);
    });

    it("reports a non-textual blob response as a placeholder, not via FileReader", () => {
        class FakeBlob {
            constructor(public size: number) {}
        }
        let readerCreated = false;
        class FakeFileReader {
            constructor() {
                readerCreated = true;
            }
            readAsText(): void {}
        }

        const { sandbox, events } = runInterceptor({
            extras: { Blob: FakeBlob, FileReader: FakeFileReader },
        });

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://cdn.example.com/img.png");
        xhr.send();
        xhr.responseType = "blob";
        xhr.rawResponseHeaders = "content-type: image/png\r\n";
        xhr.response = new FakeBlob(9001);
        xhr.emit("load");

        expect(events().find((e) => e.type === "response")!.body).toBe(
            "[binary response, 9001 bytes]"
        );
        expect(readerCreated).toBe(false);
    });

    it("emits nothing while __RN_NET_DISABLED__ is set by the SDK detector", () => {
        const { sandbox, events } = runInterceptor();
        (sandbox as Record<string, unknown>).__RN_NET_DISABLED__ = true;

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/quiet");
        xhr.send();
        xhr.emit("load");

        expect(events()).toHaveLength(0);
    });

    it("is idempotent — a second injection does not double-wrap", () => {
        const { sandbox, events } = runInterceptor();
        vm.runInContext(getInterceptorScript(), sandbox as unknown as vm.Context);

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/once");
        xhr.send();
        xhr.emit("load");

        expect(events().filter((e) => e.type === "request")).toHaveLength(1);
        expect(events().filter((e) => e.type === "response")).toHaveLength(1);
    });
});

describe("injected interceptor — fetch/XHR double-count gate", () => {
    it("suppresses the fetch wrapper when the XHR patch installed", async () => {
        const { sandbox, events } = runInterceptor({ withXhr: true, withFetch: true });

        expect(sandbox.__RN_NET_XHR_ACTIVE__).toBe(true);

        const doFetch = sandbox.fetch as (u: string) => Promise<unknown>;
        await doFetch("https://api.example.com/via-fetch");

        expect(events()).toHaveLength(0);
    });

    it("still reports from fetch in a context with no XMLHttpRequest", async () => {
        const { sandbox, events } = runInterceptor({ withXhr: false, withFetch: true });

        expect(sandbox.__RN_NET_XHR_ACTIVE__).toBeUndefined();

        const doFetch = sandbox.fetch as (u: string) => Promise<unknown>;
        await doFetch("https://api.example.com/no-xhr");

        const types = events().map((e) => e.type);
        expect(types).toContain("request");
        expect(types).toContain("response");
    });

    it("counts a fetch-over-XHR request exactly once", () => {
        // React Native's fetch is whatwg-fetch on top of XMLHttpRequest, so the
        // real polyfill drives the XHR the interceptor patched. Model that by
        // making the sandbox fetch go through XMLHttpRequest.
        const { sandbox, events } = runInterceptor({ withXhr: true, withFetch: false });

        const polyfillFetch = (url: string): Promise<unknown> => {
            const xhr = newXhr(sandbox);
            xhr.open("GET", url);
            xhr.send();
            xhr.status = 200;
            xhr.responseText = "{}";
            xhr.emit("load");
            return Promise.resolve({ status: 200, statusText: "OK" });
        };
        (sandbox as Record<string, unknown>).fetch = polyfillFetch;

        // Assigning to fetch runs the defineProperty trap, which wraps it.
        (sandbox.fetch as (u: string) => Promise<unknown>)("https://api.example.com/dual");

        expect(events().filter((e) => e.type === "request")).toHaveLength(1);
        expect(events().filter((e) => e.type === "response")).toHaveLength(1);
    });
});

describe("applyInterceptedEvent — XHR fields reach the buffer", () => {
    it("stores request headers and body, then response metadata", () => {
        const buffer = new NetworkBuffer(100);

        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id: "js-x-1",
                method: "POST",
                url: "https://api.example.com/graphql",
                timestamp: 1700000000000,
                headers: { "content-type": "application/json", "x-count": 3 },
                body: '{"query":"{ me { id } }"}',
            }),
            buffer,
            "dev"
        );

        applyInterceptedEvent(
            JSON.stringify({
                type: "response",
                id: "js-x-1",
                status: 200,
                statusText: "OK",
                duration: 42,
                responseHeaders: { "content-type": "application/json" },
                mimeType: "application/json",
                contentLength: 17,
                body: '{"data":{"me":{}}}',
                url: "https://api.example.com/graphql?r=1",
            }),
            buffer,
            "dev"
        );

        const entry = buffer.get("js-x-1")!;
        expect(entry.headers).toEqual({
            "content-type": "application/json",
            "x-count": "3",
        });
        expect(entry.postData).toBe('{"query":"{ me { id } }"}');
        expect(entry.responseHeaders).toEqual({ "content-type": "application/json" });
        expect(entry.mimeType).toBe("application/json");
        expect(entry.contentLength).toBe(17);
        expect(entry.responseBody).toBe('{"data":{"me":{}}}');
        expect(entry.url).toBe("https://api.example.com/graphql?r=1");
        expect(entry.completed).toBe(true);
    });

    it("leaves the URL alone when the response carries none", () => {
        const buffer = new NetworkBuffer(100);
        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id: "js-x-2",
                method: "GET",
                url: "https://api.example.com/keep",
            }),
            buffer,
            "dev"
        );
        applyInterceptedEvent(
            JSON.stringify({ type: "response", id: "js-x-2", status: 204 }),
            buffer,
            "dev"
        );

        expect(buffer.get("js-x-2")!.url).toBe("https://api.example.com/keep");
    });

    it("a body event patches the response body of an existing entry", () => {
        const buffer = new NetworkBuffer(100);
        applyInterceptedEvent(
            JSON.stringify({ type: "request", id: "js-x-3", method: "GET", url: "u" }),
            buffer,
            "dev"
        );
        applyInterceptedEvent(
            JSON.stringify({ type: "response", id: "js-x-3", status: 200 }),
            buffer,
            "dev"
        );
        applyInterceptedEvent(
            JSON.stringify({ type: "body", id: "js-x-3", body: "late payload" }),
            buffer,
            "dev"
        );

        expect(buffer.get("js-x-3")!.responseBody).toBe("late payload");
    });

    it("a body event for an unknown id is silently ignored", () => {
        const buffer = new NetworkBuffer(100);
        applyInterceptedEvent(
            JSON.stringify({ type: "body", id: "js-gone-1", body: "x" }),
            buffer,
            "dev"
        );
        expect(buffer.size).toBe(0);
    });

    it("drops non-object and non-scalar header values instead of trusting them", () => {
        const buffer = new NetworkBuffer(100);
        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id: "js-x-4",
                method: "GET",
                url: "u",
                headers: { good: "1", nested: { a: 1 }, arr: [1, 2] },
            }),
            buffer,
            "dev"
        );
        applyInterceptedEvent(
            JSON.stringify({
                type: "request",
                id: "js-x-5",
                method: "GET",
                url: "u",
                headers: "not-an-object",
            }),
            buffer,
            "dev"
        );

        expect(buffer.get("js-x-4")!.headers).toEqual({ good: "1" });
        expect(buffer.get("js-x-5")!.headers).toEqual({});
    });
});

describe("injected interceptor — late XMLHttpRequest", () => {
    it("keeps retrying until XMLHttpRequest exists", () => {
        // On a cold app launch the connect can land before the JS bundle has
        // defined XMLHttpRequest. A one-shot retry loses that race silently:
        // capture and mocking stay dead for the whole run, and the
        // __RN_NET_INJECTED__ guard stops any later injection repairing it.
        const pending: Array<() => void> = [];
        const lines: string[] = [];
        const sandbox: Record<string, unknown> = {
            console: { debug: (s: string) => lines.push(s) },
            setTimeout: ((fn: () => void) => {
                pending.push(fn);
                return 0;
            }) as unknown as typeof setTimeout,
        };
        vm.createContext(sandbox);
        vm.runInContext(getInterceptorScript(), sandbox);

        // Two ticks with no XMLHttpRequest at all — the old code gave up here.
        pending.splice(0).forEach((f) => f());
        pending.splice(0).forEach((f) => f());
        expect(sandbox.__RN_NET_XHR_ACTIVE__).toBeUndefined();

        // The bundle finishes evaluating and defines it.
        sandbox.XMLHttpRequest = makeFakeXhrClass();
        pending.splice(0).forEach((f) => f());

        expect(sandbox.__RN_NET_XHR_ACTIVE__).toBe(true);

        const xhr = newXhr(sandbox);
        xhr.open("GET", "https://api.example.com/late");
        xhr.send();
        const events = lines
            .map((l) => isInterceptorEvent([{ type: "string", value: l }]))
            .filter((j): j is string => j !== null)
            .map((j) => JSON.parse(j) as Record<string, unknown>);
        expect(events.find((e) => e.type === "request")!.url).toBe(
            "https://api.example.com/late"
        );
    });

    it("gives up eventually instead of rescheduling forever", () => {
        const pending: Array<() => void> = [];
        const sandbox: Record<string, unknown> = {
            console: { debug: () => {} },
            setTimeout: ((fn: () => void) => {
                pending.push(fn);
                return 0;
            }) as unknown as typeof setTimeout,
        };
        vm.createContext(sandbox);
        vm.runInContext(getInterceptorScript(), sandbox);

        let ticks = 0;
        while (pending.length > 0 && ticks < 500) {
            pending.splice(0).forEach((f) => f());
            ticks++;
        }
        expect(pending).toHaveLength(0);
        expect(ticks).toBeLessThan(100);
    });
});
