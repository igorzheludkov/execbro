import { describe, it, expect } from "@jest/globals";
import { getMeteringEndpoint, getTelemetryEndpoint } from "../../core/telemetry.js";
import { API_BASE_URL, ACCOUNTS_API_KEY } from "../../core/config.js";

describe("metering endpoint relocation", () => {
    it("metering targets the API domain, not the telemetry worker", () => {
        expect(getMeteringEndpoint()).toBe(`${API_BASE_URL}/api/usage/report`);
        expect(getMeteringEndpoint()).not.toContain("workers.dev");
    });

    it("analytics endpoint is unchanged (still the worker)", () => {
        expect(getTelemetryEndpoint()).toContain("workers.dev");
    });

    it("accounts API key is exported from config for both license and metering", () => {
        expect(ACCOUNTS_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    });
});
