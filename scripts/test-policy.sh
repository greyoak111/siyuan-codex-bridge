#!/bin/sh
set -eu
BRIDGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec /usr/bin/python3 "$BRIDGE_DIR/scripts/test_policy.py"
