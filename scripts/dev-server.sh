#!/bin/bash
# Launcher for the execbro-dev hot-reload HTTP server (port 8600).
# Idempotent: exits immediately if the server is already running.
# Invoked by the Claude Code SessionStart hook; safe to run manually.

PORT=8600
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/execbro-dev-server.log"

if lsof -ti:"$PORT" >/dev/null 2>&1; then
    exit 0
fi

# License/account backend. --http mode defaults this to localhost:3000;
# point it at production instead. Edit to test local backend changes.
export EXECBRO_API_URL="https://execbro.com"

cd "$REPO_DIR" || exit 1
nohup npm run dev:mcp >"$LOG_FILE" 2>&1 &
disown
