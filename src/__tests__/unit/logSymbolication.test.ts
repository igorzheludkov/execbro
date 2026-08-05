import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
    resolveListStacks,
    resolveFullStack,
    formatFrame,
    READ_FRAME_BUDGET,
} from "../../core/logSymbolication.js";
import { clearSymbolicateCache } from "../../core/symbolicate.js";
import { formatEventRow } from "../../core/logEventFormat.js";
import type { LogEvent } from "../../core/logEvents.js";
import type { CDPStackFrame } from "../../core/types.js";

const BUNDLE = "http://localhost:8081/index.bundle?platform=ios";

/** Four RN/React internals then app code — the shape measured on device. */
function realisticStack(appLine = 500): CDPStackFrame[] {
    return [
        { functionName: "anonymous", url: BUNDLE, lineNumber: 1167, columnNumber: 39 },
        { functionName: "overrideMethod", url: BUNDLE, lineNumber: 54216, columnNumber: 38 },
        { functionName: "reactConsoleErrorHandler", url: BUNDLE, lineNumber: 16973, columnNumber: 26 },
        { functionName: "console.level", url: BUNDLE, lineNumber: 62596, columnNumber: 34 },
        { functionName: "ProfileHeader", url: BUNDLE, lineNumber: appLine, columnNumber: 11 },
    ];
}

function event(over: Partial<LogEvent> = {}): LogEvent {
    return {
        id: "j1",
        source: "js",
        deviceKey: "dev",
        deviceName: "dev",
        ts: new Date("2026-08-05T12:00:00Z"),
        level: "error",
        kind: "message",
        title: "TypeError: boom",
        lineCount: 1,
        byteSize: 15,
        fingerprint: "abc",
        lines: [
            {
                ts: new Date("2026-08-05T12:00:00Z"),
                level: "error",
                pid: 0,
                tag: "console",
                message: "TypeError: boom",
                raw: "TypeError: boom",
            },
        ],
        stackTrace: realisticStack(),
        ...over,
    } as LogEvent;
}

/** Metro's reply: internals collapse:true, app frame collapse:false. */
function metroReply(frames: Array<Record<string, unknown> | null>): unknown {
    return { ok: true, json: async () => ({ stack: frames }) };
}

function internalFrame(name: string): Record<string, unknown> {
    return {
        file: `/app/node_modules/${name}.js`,
        lineNumber: 10,
        column: 3,
        methodName: name,
        collapse: true,
    };
}

const APP_FRAME = {
    file: "src/screens/Profile.tsx",
    lineNumber: 84,
    column: 12,
    methodName: "ProfileHeader",
    collapse: false,
};

describe("resolveListStacks", () => {
    beforeEach(() => {
        clearSymbolicateCache();
        (globalThis as any).fetch = jest.fn();
    });

    it("resolves the first NON-collapsed frame, skipping RN/React internals", async () => {
        (globalThis.fetch as any).mockResolvedValue(
            metroReply([
                internalFrame("console"),
                internalFrame("react-devtools"),
                internalFrame("ExceptionsManager"),
                internalFrame("setUpDeveloperTools"),
                APP_FRAME,
            ])
        );

        const { byEventId } = await resolveListStacks([event()]);

        expect(byEventId.get("j1")).toMatchObject({
            file: "src/screens/Profile.tsx",
            lineNumber: 84,
        });
    });

    it("sends CDP frames to Metro with line and column incremented by one", async () => {
        (globalThis.fetch as any).mockResolvedValue(metroReply([APP_FRAME]));

        await resolveListStacks([
            event({
                stackTrace: [
                    { functionName: "handler", url: BUNDLE, lineNumber: 16973, columnNumber: 26 },
                ],
            }),
        ]);

        const sent = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body).stack[0];
        expect(sent.lineNumber).toBe(16974);
        expect(sent.column).toBe(27);
    });

    it("ignores non-error levels and events with no stack", async () => {
        (globalThis.fetch as any).mockResolvedValue(metroReply([APP_FRAME]));

        const { byEventId } = await resolveListStacks([
            event({ id: "j1", level: "warn" }),
            event({ id: "j2", level: "log" }),
            event({ id: "j3", level: "error", stackTrace: undefined }),
        ]);

        expect(byEventId.size).toBe(0);
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
    });

    it("batches every event into ONE request and dedupes shared frames", async () => {
        (globalThis.fetch as any).mockResolvedValue(
            metroReply([
                internalFrame("console"),
                internalFrame("react-devtools"),
                internalFrame("ExceptionsManager"),
                internalFrame("setUpDeveloperTools"),
                APP_FRAME,
                { ...APP_FRAME, lineNumber: 99, methodName: "OtherScreen" },
            ])
        );

        const { byEventId } = await resolveListStacks([
            event({ id: "j1", stackTrace: realisticStack(500) }),
            event({ id: "j2", stackTrace: realisticStack(600) }),
        ]);

        expect((globalThis.fetch as any).mock.calls.length).toBe(1);
        // Four internals are shared, so only the two distinct app frames add
        // to the request: 6 unique, not 10.
        const sent = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body).stack;
        expect(sent).toHaveLength(6);
        expect(byEventId.get("j1")?.methodName).toBe("ProfileHeader");
        expect(byEventId.get("j2")?.methodName).toBe("OtherScreen");
    });

    it("caps distinct frames at the read budget", async () => {
        (globalThis.fetch as any).mockResolvedValue(metroReply([APP_FRAME]));

        // Each event contributes one unique frame — more events than budget.
        const events = Array.from({ length: READ_FRAME_BUDGET + 5 }, (_, i) =>
            event({
                id: `j${i}`,
                stackTrace: [
                    { functionName: `f${i}`, url: BUNDLE, lineNumber: 1000 + i, columnNumber: 1 },
                ],
            })
        );

        const { overBudget } = await resolveListStacks(events);

        const sent = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body).stack;
        expect(sent).toHaveLength(READ_FRAME_BUDGET);
        expect(overBudget).toBe(5);
    });

    it("degrades to no frames when Metro is unreachable", async () => {
        (globalThis.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
        const { byEventId } = await resolveListStacks([event()]);
        expect(byEventId.size).toBe(0);
    });

    it("degrades to no frames on a non-ok response", async () => {
        (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const { byEventId } = await resolveListStacks([event()]);
        expect(byEventId.size).toBe(0);
    });

    it("yields no frame when every frame is a framework internal", async () => {
        (globalThis.fetch as any).mockResolvedValue(
            metroReply([internalFrame("console"), internalFrame("react-devtools")])
        );

        const { byEventId } = await resolveListStacks([
            event({
                stackTrace: [
                    { functionName: "a", url: BUNDLE, lineNumber: 1, columnNumber: 1 },
                    { functionName: "b", url: BUNDLE, lineNumber: 2, columnNumber: 1 },
                ],
            }),
        ]);

        expect(byEventId.size).toBe(0);
    });
});

describe("resolveFullStack", () => {
    beforeEach(() => {
        clearSymbolicateCache();
        (globalThis as any).fetch = jest.fn();
    });

    it("renders every frame, marking internals distinctly from app code", async () => {
        (globalThis.fetch as any).mockResolvedValue(
            metroReply([internalFrame("console"), APP_FRAME])
        );

        const lines = await resolveFullStack(
            event({
                stackTrace: [
                    { functionName: "a", url: BUNDLE, lineNumber: 1, columnNumber: 1 },
                    { functionName: "ProfileHeader", url: BUNDLE, lineNumber: 2, columnNumber: 1 },
                ],
            })
        );

        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("·");
        expect(lines[1]).toContain("→");
        expect(lines[1]).toContain("src/screens/Profile.tsx:84:12 in ProfileHeader");
    });

    it("marks frames Metro could not resolve rather than dropping them", async () => {
        (globalThis.fetch as any).mockResolvedValue(metroReply([APP_FRAME, null]));

        const lines = await resolveFullStack(
            event({
                stackTrace: [
                    { functionName: "ProfileHeader", url: BUNDLE, lineNumber: 1, columnNumber: 1 },
                    { functionName: "mystery", url: BUNDLE, lineNumber: 2, columnNumber: 1 },
                ],
            })
        );

        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain("mystery");
        expect(lines[1]).toContain("unresolved");
    });

    it("returns nothing when the event has no stack or Metro is down", async () => {
        expect(await resolveFullStack(event({ stackTrace: undefined }))).toEqual([]);
        (globalThis.fetch as any).mockRejectedValue(new Error("down"));
        expect(await resolveFullStack(event())).toEqual([]);
    });
});

describe("formatEventRow with a resolved frame", () => {
    it("appends the source location as an indented continuation line", () => {
        const row = formatEventRow(event(), {
            showDevice: false,
            frames: new Map([["j1", { ...APP_FRAME, collapse: false }]]),
        });

        const [first, second] = row.split("\n");
        expect(first).toContain("TypeError: boom");
        expect(second.trim()).toBe("↳ src/screens/Profile.tsx:84:12 in ProfileHeader");
    });

    it("renders exactly as before when no frame was resolved", () => {
        const opts = { showDevice: false };
        expect(formatEventRow(event(), { ...opts, frames: new Map() })).toBe(
            formatEventRow(event(), opts)
        );
    });
});

describe("formatFrame", () => {
    it("omits the method name when there is none", () => {
        expect(formatFrame({ file: "a.ts", lineNumber: 1, column: 2, methodName: null, collapse: false }))
            .toBe("a.ts:1:2");
    });
});
