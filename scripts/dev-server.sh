#!/bin/bash
# Launcher for the execbro-dev hot-reload HTTP server (port 8600).
# Idempotent: exits immediately if the server is already running.
# Invoked by the Claude Code SessionStart hook; safe to run manually.

PORT=8600
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/execbro-dev-server.log"
LOCK_DIR="/tmp/execbro-dev-server.lock"
NODEMON="$REPO_DIR/node_modules/.bin/nodemon"

# Guard on the WATCHER, not the port. nodemon's reload cycle runs `npm run
# build` (tsc, several seconds) with the old server already exited and the new
# one not yet bound — so a port check reports "free" on every rebuild, and a
# SessionStart landing in that window starts a second watcher. The loser of the
# resulting bind race parks in nodemon's "waiting for file changes" state
# forever, still watching src/ and still running tsc on every edit. Six had
# accumulated this way by 2026-07-27.
already_running() {
    pgrep -f "$NODEMON" >/dev/null 2>&1 && return 0
    # Covers a server started directly (npm start / node build/index.js --http)
    # with no watcher in front of it.
    lsof -ti:"$PORT" >/dev/null 2>&1
}

already_running && exit 0

# Two sessions can start together and both find nothing running, because a
# freshly spawned nodemon takes a moment to become visible to pgrep. Serialise
# the check-and-spawn window; a failed mkdir means another invocation is
# already inside it, so this one has nothing to do.
if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null   # stale: a previous run died before releasing
fi
mkdir "$LOCK_DIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Re-check under the lock: the holder may have finished starting the server
# between our first check and acquiring it.
already_running && exit 0

# License/account backend. --http mode defaults this to localhost:3000;
# point it at production instead. Edit to test local backend changes.
export EXECBRO_API_URL="https://execbro.com"

cd "$REPO_DIR" || exit 1
nohup npm run dev:mcp >"$LOG_FILE" 2>&1 &
disown

# Hold the lock until the watcher is visible to pgrep, so a concurrent session
# sees it and backs off. Bounded so a failed start can never wedge the hook.
for _ in $(seq 1 25); do
    pgrep -f "$NODEMON" >/dev/null 2>&1 && break
    sleep 0.2
done
