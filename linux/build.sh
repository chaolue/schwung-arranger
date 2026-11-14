#!/usr/bin/env bash
# Build the Linux engine host: linux/build/arranger-host.
#
# With ALSA's headers installed (libasound2-dev / alsa-lib-devel) it can also
# open a "virtual" sequencer port for soft synths; without them it writes to
# raw MIDI devices (/dev/snd/midiC*D*), which needs nothing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
CC="${CC:-cc}"
mkdir -p "$HERE/build"
ALSA_FLAGS=""
if [ "${ARRANGER_NO_ALSA:-}" != "1" ] && \
   echo '#include <alsa/asoundlib.h>' | "$CC" -E -x c - >/dev/null 2>&1; then
    ALSA_FLAGS="-DHAVE_ALSA -lasound"
fi
# shellcheck disable=SC2086
"$CC" -O2 -Wall -Wextra -I"$REPO/src/dsp" -o "$HERE/build/arranger-host" \
    "$HERE/arranger_host.c" "$REPO/src/dsp/arranger_engine.c" \
    -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -lpthread -lm $ALSA_FLAGS
echo "built $HERE/build/arranger-host$([ -n "$ALSA_FLAGS" ] && echo ' (with ALSA)' || echo ' (raw MIDI devices only; install libasound2-dev for a virtual port)')"
