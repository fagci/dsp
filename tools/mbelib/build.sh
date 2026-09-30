#!/bin/sh
# Builds vendor/mbelib.wasm from mbelib (github.com/szechyjs/mbelib, ISC) with clang's wasm32 target; no emscripten or libc needed.
# usage: tools/mbelib/build.sh /path/to/mbelib   (commit 9a04ed5c78176a9965f3d43f7aa1b1f5330e771f was used)
set -e
SRC=${1:?path to an mbelib checkout}
HERE=$(cd "$(dirname "$0")" && pwd)
clang --target=wasm32 -O2 -nostdlib -ffreestanding -fsigned-char -fno-builtin-cosf -fno-builtin-powf -w \
  -I"$HERE/stub" -I"$SRC" -DHAVE_CONFIG_H=0 \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export=mbx_frame -Wl,--export=mbx_pcm -Wl,--export=mbx_data -Wl,--export=mbx_new -Wl,--export=mbx_free \
  -Wl,--export=mbx_seed -Wl,--export=mbx_reset -Wl,--export=mbx_imbe -Wl,--export=mbx_ambe2450 -Wl,--export=mbx_ambe2450_data -Wl,--export=mbx_ambe2400 -Wl,-z,stack-size=65536 -Wl,--strip-all \
  -o "$HERE/../../vendor/mbelib.wasm" "$HERE/mbelib-wasm.c" "$SRC/mbelib.c" "$SRC/ecc.c" "$SRC/imbe7200x4400.c" "$SRC/ambe3600x2400.c" "$SRC/ambe3600x2450.c"
ls -l "$HERE/../../vendor/mbelib.wasm"
