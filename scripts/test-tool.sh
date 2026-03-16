#!/bin/bash
# Test an MCP tool via HTTP transport
# Usage: ./scripts/test-tool.sh <tool_name> [json_args]
# Example: ./scripts/test-tool.sh get_connection_status
# Example: ./scripts/test-tool.sh get_logs '{"limit":5}'

TOOL=${1:?Usage: test-tool.sh <tool_name> [json_args]}
ARGS=${2:-{}}
PORT=${MCP_HTTP_PORT:-8600}

# Initialize session
INIT_RESP=$(curl -si http://localhost:$PORT/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}},"id":1}' 2>/dev/null)

SESSION_ID=$(echo "$INIT_RESP" | grep -i "mcp-session-id" | tr -d '\r' | awk '{print $2}')

if [ -z "$SESSION_ID" ]; then
  echo "ERROR: Failed to get session ID. Is the dev server running? (npm run dev:mcp)"
  exit 1
fi

# Send initialized notification
curl -s http://localhost:$PORT/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' > /dev/null 2>&1

# Call the tool
curl -s http://localhost:$PORT/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS},\"id\":2}"

echo ""
