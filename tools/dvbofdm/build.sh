#!/bin/sh
# Builds vendor/dvbofdm.wasm: the DVB-T2 receiver (tools/dvbofdm). Needs a GNU Radio checkout (gr-dtv tables and carrier maps are
# pulled out of it by gen.py; GPL-3.0-or-later) and clang with wasm32-wasi + wasi-libc + libc++ (Ubuntu: wasi-libc libc++-18-dev-wasm32).
#   git clone --depth 1 https://github.com/gnuradio/gnuradio && tools/dvbofdm/build.sh ./gnuradio
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
GR=$(cd "${1:?usage: build.sh <gnuradio checkout>}" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
python3 "$HERE/gen.py" "$GR" "$W" >/dev/null
clang++ --target=wasm32-wasi -std=c++14 -O3 -msimd128 -fcx-limited-range -fno-math-errno -fno-exceptions -fno-rtti -w -I"$W" -I"$HERE" \
  -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=134217728 -Wl,--max-memory=1073741824 \
  -mexec-model=reactor -o "$HERE/../../vendor/dvbofdm.wasm" "$HERE/api.cc"
ls -l "$HERE/../../vendor/dvbofdm.wasm"
