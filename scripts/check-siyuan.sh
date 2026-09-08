#!/bin/sh
set -eu
BRIDGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$BRIDGE_DIR/.env"
if [ ! -r "$ENV_FILE" ]; then echo "FAIL: missing $ENV_FILE"; exit 1; fi
# Read values without ever echoing the token.
SIYUAN_API_URL=$(sed -n 's/^SIYUAN_API_URL=//p' "$ENV_FILE" | head -n1)
SIYUAN_MCP_URL=$(sed -n 's/^SIYUAN_MCP_URL=//p' "$ENV_FILE" | head -n1)
TOKEN=$(sed -n 's/^SIYUAN_API_TOKEN=//p' "$ENV_FILE" | head -n1)
SIYUAN_API_URL=${SIYUAN_API_URL:-http://127.0.0.1:6806}
SIYUAN_MCP_URL=${SIYUAN_MCP_URL:-$SIYUAN_API_URL/mcp}
mode=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo unknown)
[ "$mode" = 600 ] || echo "WARN: .env permissions are $mode (expected 600)"
POLICY_FILE="$BRIDGE_DIR/config/siyuan-policy.json"
if [ -r "$POLICY_FILE" ]; then
  policy_mode=$(stat -f '%Lp' "$POLICY_FILE" 2>/dev/null || stat -c '%a' "$POLICY_FILE" 2>/dev/null || echo unknown)
  [ "$policy_mode" = 600 ] || echo "WARN: policy permissions are $policy_mode (expected 600)"
  /usr/bin/python3 - "$POLICY_FILE" <<'PY'
import json,sys
try:
 d=json.load(open(sys.argv[1])); p=d.get('profile','unknown')
 print('operation profile:', p if p in ('readonly','authoring','full') else 'invalid')
except Exception:
 print('operation profile: unreadable')
PY
else
  echo "WARN: missing operation policy $POLICY_FILE"
fi
version_body=$(mktemp); mcp_body=$(mktemp); trap 'rm -f "$version_body" "$mcp_body"' EXIT
status=$(curl -sS -o "$version_body" -w '%{http_code}' --max-time 10 "$SIYUAN_API_URL/api/system/version" || true)
echo "version endpoint ($SIYUAN_API_URL): HTTP $status"
if [ "$status" != 200 ]; then
  echo "FAIL: version endpoint is not reachable (expected HTTP 200)"
  exit 3
fi
# Parse the reported version on every run instead of comparing against a
# hard-coded release.  SiYuan currently returns {"data":"x.y.z"}, while
# accepting a nested version field keeps this check useful across API changes.
if ! version=$(/usr/bin/python3 - "$version_body" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as stream:
        payload = json.load(stream)
except (OSError, ValueError, TypeError):
    sys.exit(1)

candidates = []
if isinstance(payload, dict):
    candidates.extend((payload.get("data"), payload.get("version")))
    data = payload.get("data")
    if isinstance(data, dict):
        candidates.extend((data.get("version"), data.get("appVersion"), data.get("ver")))

for candidate in candidates:
    if not isinstance(candidate, str):
        continue
    value = candidate.strip()
    if not value or value.lower() in {"unknown", "null", "none"}:
        continue
    # Keep shell output one line and avoid control characters from a malformed
    # local response being interpreted as terminal output.
    if any(ord(char) < 0x20 or ord(char) == 0x7f for char in value):
        continue
    print(value)
    sys.exit(0)

sys.exit(1)
PY
); then
  echo "FAIL: version endpoint returned no usable version"
  exit 3
fi
echo "siyuan version: $version"
# Probe that /mcp exists without sending a placeholder token.
opt_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X OPTIONS "$SIYUAN_MCP_URL" || true)
echo "MCP endpoint ($SIYUAN_MCP_URL): OPTIONS HTTP $opt_status"
case "$TOKEN" in
  ""|PASTE_YOUR_SIYUAN_API_TOKEN_HERE)
    echo "token: FAIL (SIYUAN_API_TOKEN is not configured in $ENV_FILE)"
    echo "mcp initialize: SKIP (token required; no placeholder was sent)"
    exit 2;;
esac
mcp_status=$(curl -sS -o "$mcp_body" -w '%{http_code}' --max-time 10 -X POST "$SIYUAN_MCP_URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Token $TOKEN" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"siyuan-codex-bridge-check","version":"1.0"}}}' || true)
echo "mcp initialize: HTTP $mcp_status"
[ "$mcp_status" = 200 ] || { echo "FAIL: official MCP initialize failed"; exit 3; }
echo "PASS: Siyuan URL, token presence, version endpoint and MCP endpoint are reachable"
