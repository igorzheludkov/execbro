import { connectToDevice } from "../../core/connection.js";
import { listDebugGlobals, getComponentTree, getScreenLayout, findComponents } from "../../core/executor.js";
import { connectedApps, pendingExecutions } from "../../core/state.js";
import { DeviceInfo } from "../../core/types.js";
import { FakeCDPServer } from "../helpers/fake-cdp-server.js";

describe("Tool handlers (integration)", () => {
    let server: FakeCDPServer;

    beforeEach(async () => {
        // Clean up any existing state
        for (const [key, app] of connectedApps.entries()) {
            try { app.ws.close(); } catch { /* ignore */ }
            connectedApps.delete(key);
        }
        pendingExecutions.clear();

        // Start fake CDP server
        server = new FakeCDPServer();
        const port = await server.start();

        // Create device info pointing to fake server
        const device: DeviceInfo = {
            id: "test-device",
            title: "Hermes React Native",
            description: "Test Device",
            appId: "com.test.app",
            type: "node",
            webSocketDebuggerUrl: `${server.wsUrl}/inspector/device?page=1`,
            deviceName: "Test",
        };

        // Connect to the fake server with reconnection disabled
        await connectToDevice(device, port, {
            reconnectionConfig: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
        });
    });

    afterEach(async () => {
        // Close all connected WebSockets and wait for them to fully close
        const closePromises: Promise<void>[] = [];
        for (const [key, app] of connectedApps.entries()) {
            closePromises.push(
                new Promise<void>((resolve) => {
                    if (app.ws.readyState === app.ws.CLOSED) {
                        resolve();
                    } else {
                        app.ws.on("close", () => resolve());
                        try { app.ws.close(); } catch { resolve(); }
                    }
                })
            );
            connectedApps.delete(key);
        }
        await Promise.all(closePromises);
        pendingExecutions.clear();
        await server.stop();
    });

    describe("listDebugGlobals", () => {
        it("returns categorized globals on success", async () => {
            server.respondWithValue({
                "Apollo Client": [],
                "Redux": ["__REDUX_STORE__"],
                "React DevTools": ["__REACT_DEVTOOLS_GLOBAL_HOOK__"],
                "Reanimated": [],
                "Expo": ["expo"],
                "Metro": [],
                "Other Debug": ["__DEV__"],
            });
            const result = await listDebugGlobals();
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("Redux");
            expect(result.result).toContain("__REDUX_STORE__");
            expect(result.result).toContain("__DEV__");
        });
    });

    describe("getComponentTree", () => {
        it("returns formatted tree in JSON format", async () => {
            server.respondWithValue({
                tree: {
                    component: "App",
                    children: [
                        { component: "HomeScreen", children: [] },
                    ],
                },
            });
            const result = await getComponentTree({ format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("App");
            expect(result.result).toContain("HomeScreen");
        });

        it("returns TONL-formatted tree by default", async () => {
            server.respondWithValue({
                tree: {
                    component: "App",
                    children: [
                        { component: "HomeScreen" },
                    ],
                },
            });
            const result = await getComponentTree();
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            // TONL format uses indented component names
            expect(result.result).toContain("App");
            expect(result.result).toContain("HomeScreen");
        });

        it("returns error when no fiber roots found", async () => {
            server.respondWithValue({ error: "No fiber roots found. The app may not have rendered yet." });
            const result = await getComponentTree();
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("No fiber roots");
        });

        it("includes focused screen name when focusedOnly returns result", async () => {
            server.respondWithValue({
                focusedScreen: "ProfileScreen",
                tree: {
                    component: "ProfileScreen",
                    children: [
                        { component: "Avatar" },
                        { component: "Text" },
                    ],
                },
            });
            const result = await getComponentTree({ focusedOnly: true });
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("ProfileScreen");
        });
    });

    describe("getScreenLayout", () => {
        it("returns layout data in JSON format", async () => {
            server.respondWithValue({
                totalElements: 2,
                elements: [
                    { component: "View", path: "App > View", depth: 1, layout: { width: 375, height: 812 } },
                    { component: "Text", path: "App > View > Text", depth: 2 },
                ],
            });
            const result = await getScreenLayout({ format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("View");
            expect(result.result).toContain("375");
        });

        it("returns TONL-formatted layout by default", async () => {
            server.respondWithValue({
                totalElements: 1,
                elements: [
                    { component: "View", path: "App > View", depth: 1, layout: { width: 375 } },
                ],
            });
            const result = await getScreenLayout();
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("View");
        });

        it("returns summary mode data", async () => {
            server.respondWithValue({
                totalElements: 5,
                uniqueComponents: 2,
                components: [
                    { component: "View", count: 3 },
                    { component: "Text", count: 2 },
                ],
            });
            const result = await getScreenLayout({ summary: true });
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("View");
            expect(result.result).toContain("Text");
        });
    });

    describe("findComponents", () => {
        it("returns matching components in JSON format", async () => {
            server.respondWithValue({
                pattern: "Screen",
                found: 2,
                components: [
                    { component: "HomeScreen", path: "App > HomeScreen", depth: 2 },
                    { component: "SettingsScreen", path: "App > SettingsScreen", depth: 2 },
                ],
            });
            const result = await findComponents("Screen", { format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("HomeScreen");
            expect(result.result).toContain("SettingsScreen");
        });

        it("returns TONL-formatted results by default", async () => {
            server.respondWithValue({
                pattern: "Button",
                found: 1,
                components: [
                    { component: "SubmitButton", path: "App > Form > SubmitButton", depth: 3 },
                ],
            });
            const result = await findComponents("Button");
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("SubmitButton");
            expect(result.result).toContain("Button");
        });

        it("returns no matches when pattern does not match", async () => {
            server.respondWithValue({
                pattern: "NonExistent",
                found: 0,
                components: [],
            });
            const result = await findComponents("NonExistent", { format: "json" });
            expect(result.success).toBe(true);
            expect(result.result).toBeDefined();
            expect(result.result).toContain("NonExistent");
            expect(result.result).toContain("0");
        });
    });
});
