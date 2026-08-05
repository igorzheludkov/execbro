import vm from "node:vm";
import { getInterceptorScript, buildMockPushScript } from "../../core/networkInterceptor.js";

/**
 * Harness for the mock layer of the injected interceptor.
 *
 * The interceptor is a string of JS that only ever runs inside the app's JS
 * context, so asserting on its source text proves nothing about whether a mock
 * is ever delivered. These helpers run it for real in a `vm` context against a
 * fake XMLHttpRequest shaped like React Native's.
 */

export interface FakeXHR {
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
    readyState: number;
    rawResponseHeaders: string;
    openCalled: number;
    sendCalled: number;
    onload?: (() => void) | null;
    open(method: string, url: string): void;
    setRequestHeader(name: string, value: string): void;
    send(body?: unknown): void;
    addEventListener(type: string, fn: () => void): void;
    getAllResponseHeaders(): string;
    emit(type: string): void;
}

/**
 * A fresh class per sandbox. The interceptor patches `XMLHttpRequest.prototype`
 * in place, so a shared class would carry one test's patch — and its closure
 * over one test's console — into the next.
 */
function makeFakeXhrClass(instances: FakeXHR[]): new () => FakeXHR {
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
        readyState = 0;
        rawResponseHeaders = "";
        openCalled = 0;
        sendCalled = 0;
        onload: (() => void) | null = null;

        constructor() {
            instances.push(this);
        }

        open(method: string, url: string): void {
            this.method = method;
            this.url = url;
            this.openCalled++;
        }
        setRequestHeader(name: string, value: string): void {
            this.requestHeaders[name] = value;
        }
        send(body?: unknown): void {
            this.sentBody = body;
            this.sendCalled++;
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

export interface MockHarness {
    sandbox: Record<string, unknown>;
    /** Drains pending timers. Mock delivery is always deferred, never synchronous. */
    flush: () => void;
    events: () => Array<Record<string, unknown>>;
    newXhr: () => FakeXHR;
    /** The most recently constructed XHR — the shadow, during a tamper. */
    lastXhr: () => FakeXHR;
    push: (rules: unknown[]) => void;
}

export function runWithMocks(rules: unknown[]): MockHarness {
    const lines: string[] = [];
    const timers: Array<() => void> = [];
    const instances: FakeXHR[] = [];
    const sandbox: Record<string, unknown> = {
        console: { debug: (s: string) => lines.push(s) },
        // Deferred rather than immediate, so delayMs ordering is observable.
        setTimeout: ((fn: () => void) => {
            timers.push(fn);
            return 0;
        }) as unknown as typeof setTimeout,
        XMLHttpRequest: makeFakeXhrClass(instances),
    };
    vm.createContext(sandbox);
    vm.runInContext(getInterceptorScript(), sandbox);
    vm.runInContext(buildMockPushScript(JSON.stringify(rules)), sandbox);
    // Phase-2 timer from the interceptor's own setTimeout(…, 0).
    timers.splice(0).forEach((f) => f());

    return {
        sandbox,
        flush: () => {
            // A delivery can schedule further work; drain until quiet.
            for (let i = 0; i < 10 && timers.length > 0; i++) {
                timers.splice(0).forEach((f) => f());
            }
        },
        events: () =>
            lines
                .filter((l) => l.startsWith("__RN_NET__:"))
                .map((l) => JSON.parse(l.slice("__RN_NET__:".length)) as Record<string, unknown>),
        newXhr: () => new (sandbox.XMLHttpRequest as new () => FakeXHR)(),
        lastXhr: () => instances[instances.length - 1],
        push: (next: unknown[]) =>
            vm.runInContext(
                buildMockPushScript(JSON.stringify(next)),
                sandbox as unknown as vm.Context
            ),
    };
}
