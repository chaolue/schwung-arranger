#!/usr/bin/env bash
# Build the engine for the host machine and run the DSP tests against it.
#
# test_clock needs nothing. The engine regression tests (test_*.c using
# test_common.h) play real MIDI clips: they need a library containing the
# "Song 13 4-4 120 BPM" folder from Groove Monkee's GM Rock 2 pack (not
# redistributable, so not in the repo). Point ARRANGER_TEST_LIBRARY at it:
#
#   ARRANGER_TEST_LIBRARY="/path/to/GM Rock 2" tests/dsp/run.sh
#
# Without it they are reported as skipped, not passed.
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
# test_similar writes its own small library, so it always runs.
cc -Wall -Wextra -Werror -g -pthread -I"$REPO_ROOT/src/dsp" -I"$REPO_ROOT/tests/dsp" -o "$TMP/test_similar" \
    "$REPO_ROOT/tests/dsp/test_similar.c" "$REPO_ROOT/src/dsp/arranger_engine.c" -ldl -lm
if "$TMP/test_similar" > "$TMP/test_similar.out" 2>&1; then
    echo "test_similar: ok"
else
    echo "test_similar: FAILED"; tail -20 "$TMP/test_similar.out"; exit 1
fi

LIB="${ARRANGER_TEST_LIBRARY:-}"
if [ -z "$LIB" ]; then
    echo "engine tests: skipped (set ARRANGER_TEST_LIBRARY to a library with the Song 13 fixture)"
    exit 0
fi
status=0
for src in "$REPO_ROOT"/tests/dsp/test_*.c; do
    name="$(basename "$src" .c)"
    [ "$name" = "test_clock" ] || [ "$name" = "test_similar" ] && continue
    cc -Wall -Wextra -g -pthread -I"$REPO_ROOT/src/dsp" -I"$REPO_ROOT/tests/dsp" -o "$TMP/$name" \
        "$src" "$REPO_ROOT/src/dsp/arranger_engine.c" -ldl -lm
    if "$TMP/$name" "$LIB" > "$TMP/$name.out" 2>&1; then
        echo "$name: ok"
    else
        echo "$name: FAILED"; tail -20 "$TMP/$name.out"; status=1
    fi
done
exit $status
