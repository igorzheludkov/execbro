import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { planElectronLaunch, launchElectron, findBin, launchLogPath } from "../../core/electronLaunch.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "eb-launch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function project(dir: string, deps: Record<string, string>, bins: Record<string, string> = {}, binDir = dir) {
    mkdirSync(join(binDir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", devDependencies: deps }));
    for (const [name, body] of Object.entries(bins)) {
        const p = join(binDir, "node_modules", ".bin", name);
        writeFileSync(p, body);
        chmodSync(p, 0o755);
    }
    return dir;
}

describe("planElectronLaunch", () => {
    it("runs electron-vite dev with its own port flag when the project uses electron-vite", () => {
        const dir = project(join(root, "app"), { electron: "33", "electron-vite": "5" }, { "electron-vite": "#!/bin/sh\n", electron: "#!/bin/sh\n" });
        expect(planElectronLaunch(dir, 9333)).toEqual({
            cmd: join(dir, "node_modules", ".bin", "electron-vite"),
            args: ["dev", "--remoteDebuggingPort", "9333"],
            cwd: dir,
            runner: "electron-vite",
        });
    });
    it("runs electron . with the Chromium switch otherwise", () => {
        const dir = project(join(root, "app"), { electron: "33" }, { electron: "#!/bin/sh\n" });
        expect(planElectronLaunch(dir, 9222)).toMatchObject({ args: [".", "--remote-debugging-port=9222"], runner: "electron" });
    });
    it("finds a binary hoisted to a parent node_modules (monorepo)", () => {
        const dir = project(join(root, "apps", "desktop"), { electron: "33" }, { electron: "#!/bin/sh\n" }, root);
        expect(findBin(dir, "electron")).toBe(join(root, "node_modules", ".bin", "electron"));
        expect(planElectronLaunch(dir, 9222)).toMatchObject({ cmd: join(root, "node_modules", ".bin", "electron") });
    });
    it("refuses a packaged app: a CDP port is never opened on one", () => {
        mkdirSync(join(root, "FluentTalk.app", "Contents"), { recursive: true });
        expect(planElectronLaunch(join(root, "FluentTalk.app"), 9222)).toEqual({ error: expect.stringContaining("packaged") });
    });
    it("explains a missing folder, package.json, electron dependency or install", () => {
        expect(planElectronLaunch(join(root, "nope"), 9222)).toEqual({ error: expect.stringContaining("not a directory") });
        mkdirSync(join(root, "empty"));
        expect(planElectronLaunch(join(root, "empty"), 9222)).toEqual({ error: expect.stringContaining("package.json") });
        const web = project(join(root, "web"), { react: "19" });
        expect(planElectronLaunch(web, 9222)).toEqual({ error: expect.stringContaining("does not depend on electron") });
        const bare = join(root, "bare");
        mkdirSync(bare);
        writeFileSync(join(bare, "package.json"), JSON.stringify({ devDependencies: { electron: "33" } }));
        expect(planElectronLaunch(bare, 9222)).toEqual({ error: expect.stringContaining("npm install") });
    });
});

describe("launchElectron", () => {
    it("returns the log tail at once when the app exits early, launched without ELECTRON_RUN_AS_NODE", async () => {
        const dir = project(join(root, "app"), { electron: "33" }, {
            electron: '#!/bin/sh\necho "RUN_AS_NODE=${ELECTRON_RUN_AS_NODE:-unset}"\necho "boom" >&2\nexit 3\n',
        });
        const plan = planElectronLaunch(dir, 1);
        if ("error" in plan) throw new Error(plan.error);
        const prev = process.env.ELECTRON_RUN_AS_NODE;
        process.env.ELECTRON_RUN_AS_NODE = "1";
        try {
            const r = await launchElectron(plan, 1, 10_000, join(root, "logs"));
            expect(r.ok).toBe(false);
            if (r.ok) return;
            expect(r.error).toContain("exited (3)");
            expect(r.error).toContain("RUN_AS_NODE=unset");
            expect(r.error).toContain("boom");
        } finally {
            if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
            else process.env.ELECTRON_RUN_AS_NODE = prev;
        }
    });
});

describe("launchElectron, app pins its own port", () => {
    let server: Server;
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    it("follows the port Chromium reports in the log when the app overrides the flag", async () => {
        // A stand-in /json listing: one Electron window, as Chromium serves it.
        // The first listing is taken before the page has set document.title, so
        // Chromium reports the URL as the title; a window named after it would not
        // match device: "Pinned".
        let hits = 0;
        server = createServer((_req, res) => {
            const title = hits++ === 0 ? "localhost:5173/" : "Pinned";
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify([{ id: "A1", type: "page", title, description: "", url: "http://localhost:5173/", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/A1" }]));
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const real = (server.address() as AddressInfo).port;
        const dir = project(join(root, "app"), { electron: "33" }, {
            electron: `#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:${real}/devtools/browser/x"\nexec sleep 30\n`,
        });
        const plan = planElectronLaunch(dir, 1);
        if ("error" in plan) throw new Error(plan.error);
        const r = await launchElectron(plan, 1, 10_000, join(root, "logs"));
        try {
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            expect(r.port).toBe(real);
            expect(r.devices.map((d) => d.title)).toEqual(["Pinned"]);
        } finally {
            if (r.ok) process.kill(-r.pid);
        }
    });
});

describe("launchLogPath", () => {
    it("gives two projects with the same folder name their own log", () => {
        const a = launchLogPath("/logs", "/a/apps/desktop");
        const b = launchLogPath("/logs", "/b/apps/desktop");
        expect(a).not.toBe(b);
        expect(a).toMatch(/^\/logs\/desktop-[0-9a-f]{8}\.log$/);
        expect(launchLogPath("/logs", "/a/apps/desktop")).toBe(a);
    });
});

describe("launchElectron deadline", () => {
    let server: Server;
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    async function run(listing: () => unknown[], timeoutMs: number) {
        server = createServer((_req, res) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(listing()));
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const real = (server.address() as AddressInfo).port;
        const dir = project(join(root, "app"), { electron: "33" }, {
            electron: `#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:${real}/devtools/browser/x"\nexec sleep 30\n`,
        });
        const plan = planElectronLaunch(dir, 1);
        if ("error" in plan) throw new Error(plan.error);
        return { real, r: await launchElectron(plan, 1, timeoutMs, join(root, "logs")) };
    }

    it("connects a window that is still untitled when the deadline lands in the title grace", async () => {
        const { r } = await run(() => [{ id: "A1", type: "page", title: "localhost:5173/", description: "", url: "http://localhost:5173/", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/A1" }], 1500);
        try {
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.devices).toHaveLength(1);
        } finally {
            if (r.ok) process.kill(-r.pid);
        }
    });

    it("names the port it followed, not the requested one, when no window appears", async () => {
        const { real, r } = await run(() => [], 1200);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toContain(`Port ${real} listed no window`);
        const pid = /pid (\d+)/.exec(r.error)?.[1];
        if (pid) process.kill(-Number(pid));
    });
});
