#!/bin/sh
# Builds vendor/leandvb.wasm from LeanSDR (https://github.com/pabr/leansdr, GPL-3.0-or-later, commit e6416aa323fdfa553b7cb1420c3291acaeb7b65a):
#   git clone https://github.com/pabr/leansdr && git -C leansdr checkout e6416aa323fdfa553b7cb1420c3291acaeb7b65a && tools/leandvb/build.sh ./leansdr
# Needs clang (wasm32-wasi) and wasi-libc + libc++ for wasm32 (Ubuntu: wasi-libc libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "${1:?usage: build.sh <leansdr checkout>}" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cp -r "$SRC/src/leansdr" "$W/leansdr"; cp "$SRC/src/apps/leandvb.cc" "$W/leandvb.cc"
patch -s "$W/leandvb.cc" < "$HERE/leandvb-wasm.patch"
cp "$HERE/leandvb-wasm.cc" "$W/"
clang++ --target=wasm32-wasi -std=c++14 -O3 -fno-exceptions -fno-rtti -w -I"$W" -DVERSION='"wasm"' \
  -Wl,--strip-all -Wl,-z,stack-size=262144 -Wl,--initial-memory=33554432 -Wl,--max-memory=268435456 \
  -mexec-model=reactor -o "$HERE/../../vendor/leandvb.wasm" "$W/leandvb-wasm.cc"
ls -l "$HERE/../../vendor/leandvb.wasm"
