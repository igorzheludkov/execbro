# HTTP Transport Dev Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTTP transport mode to the MCP server so developers can use nodemon hot-reload without restarting Claude Code sessions.

**Architecture:** The `main()` function checks for `--http` flag. If present, starts an HTTP server on port 8600 with `StreamableHTTPServerTransport` instead of stdio. All tool registrations remain at module level — only the transport layer changes. A new `npm run dev:mcp` script combines build+watch+http flag.

**Tech Stack:** `@modelcontextprotocol/sdk` StreamableHTTPServerTransport, Node.js `http.createServer`, existing nodemon setup.

---

## Chunk 1: HTTP Transport Mode

### Task 1: Add HTTP transport to main()

**Files:**
- Modify: `src/index.ts:1-5` (imports)
- Modify: `src/index.ts:3620-3646` (main function)

- [ ] **Step 1: Add StreamableHTTPServerTransport import**

Add to the imports at the top of `src/index.ts`:

```typescript
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
```

Note: `node:http` `createServer` is different from the one in `httpServer.ts` — this is for the MCP HTTP endpoint, not the debug HTTP server.

- [ ] **Step 2: Modify main() to support --http flag**

Replace the transport section of `main()` with:

```typescript
async function main() {
    initTelemetry();

    await startDebugHttpServer();
    console.error("[rn-ai-debugger] HTTP server started in-process");

    const useHttp = process.argv.includes("--http");
    const httpPort = parseInt(process.env.MCP_HTTP_PORT || "8600", 10);

    if (useHttp) {
        // HTTP transport mode — for development with hot-reload
        const transports = new Map<string, StreamableHTTPServerTransport>();

        const httpServer = createServer(async (req, res) => {
            const url = new URL(req.url || "", `http://localhost:${httpPort}`);

            if (url.pathname === "/mcp") {
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (sessionId) => {
                        transports.set(sessionId, transport);
                        console.error(`[rn-ai-debugger] HTTP session created: ${sessionId}`);
                    }
                });

                transport.onclose = () => {
                    if (transport.sessionId) {
                        transports.delete(transport.sessionId);
                        console.error(`[rn-ai-debugger] HTTP session closed: ${transport.sessionId}`);
                    }
                };

                await server.connect(transport);
                await transport.handleRequest(req, res);
                return;
            }

            // Handle existing sessions
            const sessionId = req.headers["mcp-session-id"] as string | undefined;
            if (sessionId && transports.has(sessionId)) {
                const transport = transports.get(sessionId)!;
                await transport.handleRequest(req, res);
                return;
            }

            res.writeHead(404);
            res.end("Not found");
        });

        httpServer.listen(httpPort, () => {
            console.error(`[rn-ai-debugger] MCP HTTP server listening on http://localhost:${httpPort}/mcp`);
        });
    } else {
        // Stdio transport mode — default for production
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[rn-ai-debugger] Server started on stdio");
    }

    // Auto-connect to Metro in background (non-blocking)
    setImmediate(() => {
        autoConnectToMetro().catch((err) => {
            console.error("[rn-ai-debugger] Auto-connect failed:", err);
        });
    });
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 4: Verify stdio mode still works**

Run: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}},"id":1}' | node build/index.js 2>/dev/null | head -c 200`
Expected: JSON response with server capabilities (same as before).

- [ ] **Step 5: Verify HTTP mode starts**

Run: `node build/index.js --http &; sleep 1; curl -s http://localhost:8600/mcp -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}},"id":1}'; kill %1`
Expected: JSON response with server capabilities over HTTP.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add HTTP transport mode for dev hot-reload (--http flag)"
```

### Task 2: Add dev:mcp npm script

**Files:**
- Modify: `package.json:13` (scripts section)

- [ ] **Step 1: Add dev:mcp script**

Add to `package.json` scripts:

```json
"dev:mcp": "nodemon --watch src --ext ts --exec 'npm run build && node build/index.js --http'"
```

- [ ] **Step 2: Verify dev:mcp works**

Run: `npm run dev:mcp`
Expected: Server starts on HTTP port 8600. Modifying any `.ts` file in `src/` triggers rebuild and restart.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add dev:mcp script for HTTP hot-reload development"
```

### Task 3: Document dev setup in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add dev workflow section to CLAUDE.md**

Add after the "Common Commands" section:

```markdown
## Development with Hot Reload

For development, use HTTP transport mode to avoid restarting Claude Code sessions:

```bash
npm run dev:mcp    # Builds + runs with HTTP transport, auto-restarts on file changes
```

Configure Claude Code to connect via HTTP (in `.claude/settings.json` MCP config):
```json
{
  "url": "http://localhost:8600/mcp"
}
```

A SessionStart hook can auto-launch the dev server:
```json
{
  "hooks": {
    "SessionStart": [{
      "command": "cd /path/to/react-native-ai-debugger && (lsof -ti:8600 > /dev/null 2>&1 || npm run dev:mcp > /tmp/rn-debugger-dev.log 2>&1 &)"
    }]
  }
}
```

Production users are unaffected — the default transport remains stdio.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add HTTP transport dev workflow to CLAUDE.md"
```
