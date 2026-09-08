#!/bin/sh
set -eu
BRIDGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
/usr/bin/python3 "$BRIDGE_DIR/scripts/test_mcp.py"
/usr/bin/python3 "$BRIDGE_DIR/scripts/test_policy.py"
