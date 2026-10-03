#!/usr/bin/env bash
# Build the engine for the host machine and run the DSP tests against it.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cc -O2 -shared -fPIC -Wall -Wextra -Werror -I"$REPO_ROOT/src/dsp" -o "$TMP/dsp.so" \
    "$REPO_ROOT/src/dsp/arranger_engine.c" -lpthread -lm \
    -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0
cc -O0 -Wall -Wextra -I"$REPO_ROOT/src/dsp" -o "$TMP/test_clock" \
    "$REPO_ROOT/tests/dsp/test_clock.c" -ldl
"$TMP/test_clock" "$TMP/dsp.so"
