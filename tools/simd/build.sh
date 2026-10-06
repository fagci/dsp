#!/bin/sh
# Builds modules/simd-kernels.js: WASM SIMD kernels (tools/simd/*.c) embedded as base64 + a synchronous loader.
# clang's wasm32 target only (no Emscripten, no libc); the module imports env.memory.
# usage: tools/simd/build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=$(mktemp -d)
clang --target=wasm32 -O3 -msimd128 -nostdlib -fno-builtin -Wl,--no-entry -Wl,--export=poly -Wl,--import-memory \
  -Wl,--allow-undefined -Wl,--strip-all -o "$OUT/simd.wasm" "$HERE/poly.c"
B64=$(base64 -w0 "$OUT/simd.wasm")
SIZE=$(wc -c < "$OUT/simd.wasm")
sed -e "s|@B64@|$B64|" -e "s|@SIZE@|$SIZE|" "$HERE/simd-kernels.tpl.js" > "$ROOT/modules/simd-kernels.js"
echo "modules/simd-kernels.js: $SIZE bytes of wasm"
