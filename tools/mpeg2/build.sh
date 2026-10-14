#!/bin/sh
# Builds vendor/mpeg2.wasm: the MPEG-2 video decoder (mpeg2.c) and the MP2 audio decoder (mp2.c), clang wasm32 target, no libc.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
clang --target=wasm32 -O2 -mbulk-memory -nostdlib -ffreestanding -fno-builtin -w -I"$HERE" \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export=m2_reset -Wl,--export=m2_in -Wl,--export=m2_cap -Wl,--export=m2_w -Wl,--export=m2_h \
  -Wl,--export=m2_aspect -Wl,--export=m2_prog -Wl,--export=m2_err -Wl,--export=m2_pics -Wl,--export=m2_bad -Wl,--export=m2_rate \
  -Wl,--export=m2_frame -Wl,--export=m2_pts -Wl,--export=m2_decode -Wl,--export=m2_flush -Wl,--export=memory \
  -Wl,-z,stack-size=65536 -Wl,--strip-all \
  -Wl,--export=a2_reset -Wl,--export=a2_in -Wl,--export=a2_cap -Wl,--export=a2_pcm -Wl,--export=a2_rate -Wl,--export=a2_mode -Wl,--export=a2_kbps -Wl,--export=a2_feed \
  -o "$HERE/../../vendor/mpeg2.wasm" "$HERE/mpeg2.c" "$HERE/mp2.c"
ls -l "$HERE/../../vendor/mpeg2.wasm"
