import { describe, it, expect, jest, beforeEach } from "@jest/globals";

type ToolReg = { name: string; config: { description: string; inputSchema: Record<string, unknown> } };
const registered: ToolReg[] = [];

jest.unstable_mockModule("../../core/register.js", () => ({
    registerToolWithTelemetry: (
        _server: unknown,
        name: string,
        config: ToolReg["config"]
    ) => {
        registered.push({ name, config });
    },
}));

const { registerInteractionTools } = await import("../../tools/interactionTools.js");

// Not every tool in this module goes through registerToolWithTelemetry — some
// call server.registerTool directly — so the stub server records that path too.
const stubServer = {
    registerTool: (name: string, config: ToolReg["config"]) => {
        registered.push({ name, config });
    },
};

describe("pinch tool registration", () => {
    beforeEach(() => {
        registered.length = 0;
        registerInteractionTools(stubServer as never);
    });

    it("registers a pinch tool", () => {
        expect(registered.map((t) => t.name)).toContain("pinch");
    });

    it("exposes the documented parameters", () => {
        const pinch = registered.find((t) => t.name === "pinch");
        const keys = Object.keys(pinch!.config.inputSchema);
        for (const k of ["direction", "scale", "x", "y", "angle", "span", "durationMs", "device", "verify", "screenshot", "burst"]) {
            expect(keys).toContain(k);
        }
    });

    it("states that it sends real two-finger events and is emulator-only", () => {
        const desc = registered.find((t) => t.name === "pinch")!.config.description;
        expect(desc).toMatch(/two-finger|multi-touch/i);
        expect(desc).toMatch(/emulator/i);
    });

    it("leaves span without a schema default so direction can decide it", () => {
        // A schema-level .default() would make "caller passed 1" and "nothing
        // passed" indistinguishable, and the handler could not pick a smaller
        // default for direction="in".
        const schema = registered.find((t) => t.name === "pinch")!.config
            .inputSchema as Record<string, { isOptional?: () => boolean; _def?: unknown }>;
        const span = schema.span as unknown as { _def?: { typeName?: string } };
        expect(JSON.stringify(span?._def ?? {})).not.toMatch(/ZodDefault/);
    });

    it("documents both span defaults", () => {
        const schema = registered.find((t) => t.name === "pinch")!.config.inputSchema;
        const text = JSON.stringify(schema);
        expect(text).toMatch(/0\.5/);
        expect(text).toMatch(/direction/);
    });

    it("documents the screenshot-pixel coordinate space", () => {
        const schema = registered.find((t) => t.name === "pinch")!.config.inputSchema as Record<
            string,
            { description?: string }
        >;
        expect(JSON.stringify(schema)).toMatch(/screenshot pixel/i);
    });
});
