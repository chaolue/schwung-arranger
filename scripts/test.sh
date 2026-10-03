#!/usr/bin/env bash
# Run the UI behaviour tests under Node (18+).
#
# ui.js imports Schwung's shared modules from the device path
# /data/UserData/schwung/shared/, so the tests need a Schwung checkout:
#   SCHWUNG_DIR=/path/to/schwung ./scripts/test.sh
# (defaults to ../schwung beside this repo).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SCHWUNG_DIR="${SCHWUNG_DIR:-$REPO_ROOT/../schwung}"

if [ ! -f "$SCHWUNG_DIR/src/shared/menu_layout.mjs" ]; then
    echo "error: no Schwung checkout at $SCHWUNG_DIR (set SCHWUNG_DIR)" >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -r "$SCHWUNG_DIR/src/shared" "$TMP/shared"
cp "$REPO_ROOT"/tests/ui/*.mjs "$TMP/"
sed -e "s#'/data/UserData/schwung/shared/#'./shared/#g" \
    -e "s#import \* as os from 'os';#import * as os from './os_mock.mjs';#" \
    "$REPO_ROOT/src/ui.js" > "$TMP/ui_test.mjs"

# One process per suite: ui.js keeps module state, so each starts fresh.
status=0
for suite in "$TMP"/run*.mjs; do
    echo "== $(basename "$suite")"
    node "$suite" || status=1
done
echo "== tests/dsp"
"$REPO_ROOT/tests/dsp/run.sh" || status=1
exit $status
