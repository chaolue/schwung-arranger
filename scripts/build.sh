#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="schwung-arranger-builder"

if [ -z "$CROSS_PREFIX" ] && [ ! -f "/.dockerenv" ]; then
    echo "=== Building Arranger Module (via Docker) ==="
    if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"
    fi
    docker run --rm \
        -v "$REPO_ROOT:/build" \
        -u "$(id -u):$(id -g)" \
        -w /build \
        "$IMAGE_NAME" \
        bash scripts/build.sh
    exit 0
fi

CROSS_PREFIX="${CROSS_PREFIX:-aarch64-linux-gnu-}"

cd "$REPO_ROOT"
mkdir -p build dist/arranger

${CROSS_PREFIX}gcc -O2 -shared -fPIC \
    -march=armv8-a -mtune=cortex-a72 \
    -fomit-frame-pointer -fno-stack-protector \
    -Wall -Wextra -Werror \
    -DNDEBUG \
    -Isrc/dsp \
    src/dsp/arranger_engine.c \
    -o build/dsp.so

cp src/module.json dist/arranger/module.json
cp build/dsp.so dist/arranger/dsp.so
chmod +x dist/arranger/dsp.so

# UI ships as-is; host copies it at load time.
cp src/ui.js dist/arranger/ui.js || true

[ -f LICENSE ] && cp LICENSE dist/arranger/LICENSE || true

cd dist
tar -czvf arranger-module.tar.gz arranger/
echo "OK: dist/arranger-module.tar.gz"
