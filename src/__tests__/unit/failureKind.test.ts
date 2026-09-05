// Argent Gap Closure item 1 / spec 2026-07-31-structured-failure-kind-design.
//
// The point of failureKind is that classification stops depending on error
// prose. That only holds while the kind and the message agree, so the load-
// bearing test here is the one that asserts both halves of a branch together:
// if someone reworks describeDeviceResolution's wording and forgets
// failureKindForResolution, this fails.

process.env.RN_AI_DEVTOOLS_TEST_MODE = "1";

import { describe, it, expect } from "@jest/globals";
import { ENVIRONMENT_KINDS, EnvironmentError, UserInputError, type FailureKind } from "../../core/errors.js";
import { describeDeviceResolution, failureKindForResolution } from "../../core/connection.js";
import type { ConnectedApp } from "../../core/types.js";

const app = (deviceName: string, platform: string): ConnectedApp =>
    ({ deviceInfo: { deviceName }, platform }) as unknown as ConnectedApp;

describe("failureKindForResolution", () => {
    it("returns no kind when resolution succeeded", () => {
        expect(failureKindForResolution({ kind: "ok", app: app("x", "ios") } as never)).toBeUndefined();
    });

    it("treats an ambiguous name as an agent mistake, not an environment state", () => {
        const resolution = { kind: "ambiguous", device: "iPhone", matches: [app("iPhone 15", "ios"), app("iPhone Air", "ios")] } as never;
        expect(failureKindForResolution(resolution)).toBeUndefined();
    });

    it("no device argument and nothing connected → no_apps_connected", () => {
        const resolution = { kind: "none", device: undefined, connected: [] } as never;
        expect(failureKindForResolution(resolution)).toBe("no_apps_connected");
    });

    it("named device with nothing connected → no_devices_attached", () => {
        const resolution = { kind: "none", device: "Pixel 8", connected: [] } as never;
        expect(failureKindForResolution(resolution)).toBe("no_devices_attached");
    });

    it("named device while others are attached → platform_mismatch, held out of the environment bucket", () => {
        const resolution = { kind: "none", device: "iPhone Air", connected: [app("sdk_gphone16k_arm64", "android")] } as never;
        expect(failureKindForResolution(resolution)).toBe("platform_mismatch");
        // The distinction that makes this worth a separate kind: devices WERE
        // attached, so the tool could have succeeded with a different argument.
        expect(ENVIRONMENT_KINDS.has("platform_mismatch" as FailureKind)).toBe(false);
    });

    // The overlap-period guarantee: for each branch the kind and the prose must
    // describe the same thing, so a row's blob21 can be checked against its
    // message while both classification arms are live.
    it.each([
        [{ kind: "none", device: undefined, connected: [] }, "no_apps_connected", /no apps connected/i],
        [{ kind: "none", device: "Pixel 8", connected: [] }, "no_devices_attached", /no devices are currently connected/i],
    ])("kind and message agree for %o", (resolution, expectedKind, messagePattern) => {
        expect(failureKindForResolution(resolution as never)).toBe(expectedKind);
        expect(describeDeviceResolution(resolution as never)).toMatch(messagePattern as RegExp);
    });
});

describe("carriers", () => {
    it("EnvironmentError keeps the kind readable off the thrown value", () => {
        const err = new EnvironmentError("No Metro server found.", "no_metro_server");
        expect(err.kind).toBe("no_metro_server");
        // Must NOT be a UserInputError: those are skipped by error tracking,
        // and a setup failure is not an agent mistake.
        expect(err instanceof UserInputError).toBe(false);
    });

    it("UserInputError carries a kind without losing its existing context tag", () => {
        const err = new UserInputError("No connected device matches …", "no_devices_connected", "no_devices_attached");
        expect(err.context).toBe("no_devices_connected");
        expect(err.kind).toBe("no_devices_attached");
    });
});

describe("ENVIRONMENT_KINDS", () => {
    it("excludes exactly the two kinds that are not setup failures", () => {
        expect(ENVIRONMENT_KINDS.has("platform_mismatch" as FailureKind)).toBe(false);
        expect(ENVIRONMENT_KINDS.has("fiber_guard_unexpected" as FailureKind)).toBe(false);
        expect(ENVIRONMENT_KINDS.size).toBe(11);
    });
});
