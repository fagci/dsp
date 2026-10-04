#!/bin/sh
# Builds vendor/tetra-acelp.wasm (TETRA ACELP speech decoder) with clang's wasm32 target; no Emscripten, no libc.
# usage: tools/tetra-acelp/build.sh /path/to/tetra-codec   (a checkout of github.com/outerplane/tetra-codec: source/ and include/)
# The sources are ETSI EN 300 395-2 reference code (the old TETRA ACELP, not AMR-WB / EVS); the codec may be covered by patents.
set -e
SRC=${1:?path to a tetra-codec checkout}
HERE=$(cd "$(dirname "$0")" && pwd)
clang --target=wasm32 -O2 -nostdlib -ffreestanding -fsigned-char -w -I"$HERE/stub" -I"$SRC/include" -I"$SRC/source" \
  -Wl,--no-entry -Wl,--export=ta_bits -Wl,--export=ta_pcm -Wl,--export=ta_new -Wl,--export=ta_free -Wl,--export=ta_decode \
  -Wl,--strip-all -Wl,-z,stack-size=65536 \
  -o "$HERE/../../vendor/tetra-acelp.wasm" "$HERE/tetra-acelp-wasm.c" "$SRC/source/tetra-codec.c" "$SRC/source/tetra-codec-impl.c"
ls -l "$HERE/../../vendor/tetra-acelp.wasm"
