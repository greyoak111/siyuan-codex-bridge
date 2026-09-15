#!/bin/sh
# Publish this package to npm.
#
# The account's 2FA is a passkey (Touch ID), so there is no one-time code to
# type and a non-interactive `npm publish` stops at `EOTP`. This script handles
# both shapes of that:
#
#   1. The token in ~/.npmrc is still valid — publish straight away, no
#      interaction at all. This is the normal path for a release a few days
#      after the last one.
#   2. It is not — npm hands out a browser approval link instead of an OTP.
#      The script prints that link (and opens it), waits for the approval, keeps
#      the resulting token in ~/.npmrc, and then publishes. One Touch ID.
#
# Run from anywhere: the repo root is derived from this file's location.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

NPM=${NPM:-npm}
# The harness exports this for pnpm; npm warns about it on every command.
unset npm_config_side_effects_cache || true

NAME=$("$NPM" pkg get name | tr -d '"')
VERSION=$("$NPM" pkg get version | tr -d '"')
TARBALL_ARGS=""

usage() {
    cat <<'EOF'
usage: scripts/publish-npm.sh [--dry-run]

  --dry-run   print what would be published and stop before uploading
EOF
}

for arg in "$@"; do
    case "$arg" in
        --dry-run) TARBALL_ARGS="--dry-run" ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done

echo "package: $NAME@$VERSION"

if [ -z "$TARBALL_ARGS" ] && "$NPM" view "$NAME@$VERSION" version >/dev/null 2>&1; then
    echo "already published: $NAME@$VERSION — bump the version in package.json first"
    exit 0
fi

# A dirty tree means the tag will not match what ships; the publish itself is
# still allowed, because releasing a hotfix from a dirty tree is a real thing.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "warning: working tree is dirty — commit and tag so the release matches the source" >&2
fi

# 1. Straight publish: works while the stored token is still valid.
if [ -n "$TARBALL_ARGS" ]; then
    "$NPM" publish $TARBALL_ARGS
    exit $?
fi

set +e
OUTPUT=$("$NPM" publish 2>&1)
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | grep -v '^npm warn' || true
if [ "$STATUS" -eq 0 ]; then
    "$NPM" view "$NAME@$VERSION" version dist.tarball
    exit 0
fi

printf '%s' "$OUTPUT" | grep -qE 'EOTP|ENEEDAUTH' || exit "$STATUS"

# 2. Approval needed. npm only prints the link on a terminal, so run the publish
#    under a pty with stdin held open (a bare pipe would close it before the
#    approval and the link would never be printed).
echo "approval needed: requesting a browser link from npm"
TYPESCRIPT=$(mktemp -t dsh-npm-publish)
FLOWLOG=$(mktemp -t dsh-npm-flow)
( printf '\n'; sleep 1200 ) | script -q "$TYPESCRIPT" "$NPM" publish >"$FLOWLOG" 2>&1 &
FLOW=$!

URL=""
for _ in $(seq 1 40); do
    URL=$(grep -oE 'https://www\.npmjs\.com/auth/cli/[A-Za-z0-9-]+' "$FLOWLOG" 2>/dev/null | head -1 || true)
    [ -n "$URL" ] && break
    sleep 1
done

if [ -z "$URL" ]; then
    echo "npm never printed an approval link — see $FLOWLOG" >&2
    kill "$FLOW" 2>/dev/null || true
    exit 1
fi

AUTHID=${URL##*/}
echo
echo "Open this link and approve with Touch ID (valid for a few minutes):"
echo "  $URL"
echo
if command -v open >/dev/null 2>&1; then open "$URL" 2>/dev/null || true; fi

# 3. Poll for the token the approval unlocks, store it, publish with it.
i=0
while [ "$i" -lt 120 ]; do
    BODY=$(curl -s -m 20 "https://registry.npmjs.org/-/v1/done?authId=$AUTHID" || true)
    TOKEN=$(printf '%s' "$BODY" | /usr/bin/python3 -c 'import json,sys
try:
    value = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
print(value.get("token", "") if isinstance(value, dict) else "")' 2>/dev/null || true)
    if [ -n "$TOKEN" ]; then
        printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$HOME/.npmrc"
        chmod 600 "$HOME/.npmrc"
        echo "approved — token stored in ~/.npmrc, publishing"
        kill "$FLOW" 2>/dev/null || true
        "$NPM" publish
        "$NPM" view "$NAME@$VERSION" version dist.tarball
        rm -f "$TYPESCRIPT" "$FLOWLOG"
        exit 0
    fi
    i=$((i + 1))
    sleep 5
done

echo "timed out waiting for the approval — run this script again for a fresh link" >&2
kill "$FLOW" 2>/dev/null || true
rm -f "$TYPESCRIPT" "$FLOWLOG"
exit 1
