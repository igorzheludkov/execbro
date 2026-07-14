import { describe, it, expect } from "@jest/globals";
import { resolveTelemetryModes } from "../../core/telemetry.js";

describe("resolveTelemetryModes", () => {
    it("normal (configured, no opt-out, not dev): both on", () => {
        const modes = resolveTelemetryModes({ envOptOut: false, devMode: false, endpointConfigured: true });
        expect(modes).toEqual({ telemetryEnabled: true, meteringEnabled: true });
    });

    it("EXECBRO_TELEMETRY opt-out: analytics off, metering stays on", () => {
        const modes = resolveTelemetryModes({ envOptOut: true, devMode: false, endpointConfigured: true });
        expect(modes).toEqual({ telemetryEnabled: false, meteringEnabled: true });
    });

    it("dev mode: both off, even if opt-out is not set", () => {
        const modes = resolveTelemetryModes({ envOptOut: false, devMode: true, endpointConfigured: true });
        expect(modes).toEqual({ telemetryEnabled: false, meteringEnabled: false });
    });

    it("dev mode wins even when combined with opt-out", () => {
        const modes = resolveTelemetryModes({ envOptOut: true, devMode: true, endpointConfigured: true });
        expect(modes).toEqual({ telemetryEnabled: false, meteringEnabled: false });
    });

    it("unconfigured endpoint (placeholder): both off", () => {
        const modes = resolveTelemetryModes({ envOptOut: false, devMode: false, endpointConfigured: false });
        expect(modes).toEqual({ telemetryEnabled: false, meteringEnabled: false });
    });

    it("unconfigured endpoint wins even when combined with opt-out", () => {
        const modes = resolveTelemetryModes({ envOptOut: true, devMode: false, endpointConfigured: false });
        expect(modes).toEqual({ telemetryEnabled: false, meteringEnabled: false });
    });
});
