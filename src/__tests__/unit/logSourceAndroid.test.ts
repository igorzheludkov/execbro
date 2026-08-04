import { describe, it, expect } from "@jest/globals";
import { buildLogcatArgs, parseLogcatEpoch } from "../../core/logSourceAndroid.js";

describe("buildLogcatArgs", () => {
    it("always reads the crash buffer alongside main", () => {
        // -b crash is tiny (121 lines) and near-100% signal; it is also the
        // only place a tombstone lands.
        expect(buildLogcatArgs({ serial: "emulator-5554" }).join(" ")).toContain("-b crash,main");
    });

    it("uses epoch, not year, for timestamps", () => {
        // -v year prints device-local wall time with NO utc offset, so a device
        // in another timezone silently shifts every entry.
        const args = buildLogcatArgs({ serial: "emulator-5554" }).join(" ");
        expect(args).toContain("-v epoch");
        expect(args).not.toContain("-v year");
    });

    it("passes the device serial", () => {
        expect(buildLogcatArgs({ serial: "emulator-5554" }).join(" ")).toContain("-s emulator-5554");
    });

    it("windows on the watermark when given", () => {
        const args = buildLogcatArgs({ sinceTs: new Date("2026-07-29T22:12:00.000Z") });
        // argv form: the stamp is its own element and carries no quotes, which
        // logcat would otherwise read as part of the timestamp.
        expect(args[args.indexOf("-T") + 1]).toMatch(/^1785[0-9]{6}\.000$/);
    });

    it("omits --pid when the app is dead", () => {
        expect(buildLogcatArgs({}).join(" ")).not.toContain("--pid");
    });
});

describe("parseLogcatEpoch", () => {
    const SAMPLE = [
        "--------- beginning of main",
        "         1785352265.203  1210 13886 I NearbyMediums: Wifi changed new SSID",
        "         1785352265.015 22617 22617 F DEBUG   : Cmdline: com.rndebuggertestapp",
        "         1785352265.015 22617 22617 F DEBUG   : pid: 17782, tid: 17832, name: x  >>> com.rndebuggertestapp <<<",
        "         1785352266.100   660   813 E ActivityManager: ANR in com.rndebuggertestapp",
    ].join("\n");

    it("skips banner lines", () => {
        expect(parseLogcatEpoch(SAMPLE).some((l) => l.message.includes("beginning of"))).toBe(false);
    });

    it("parses pid, tid, level, tag and message", () => {
        const first = parseLogcatEpoch(SAMPLE)[0];
        expect(first.pid).toBe(1210);
        expect(first.tid).toBe(13886);
        expect(first.level).toBe("info");
        expect(first.tag).toBe("NearbyMediums");
        expect(first.message).toBe("Wifi changed new SSID");
    });

    it("maps F to fatal and E to error", () => {
        const lines = parseLogcatEpoch(SAMPLE);
        expect(lines[1].level).toBe("fatal");
        expect(lines[3].level).toBe("error");
    });

    it("extracts the declared subject from Cmdline:", () => {
        expect(parseLogcatEpoch(SAMPLE)[1].subject).toBe("com.rndebuggertestapp");
    });

    it("extracts the declared subject from >>> pkg <<<", () => {
        expect(parseLogcatEpoch(SAMPLE)[2].subject).toBe("com.rndebuggertestapp");
    });

    it("converts epoch seconds to an absolute Date", () => {
        expect(parseLogcatEpoch(SAMPLE)[0].ts.getTime()).toBe(1785352265203);
    });
});
