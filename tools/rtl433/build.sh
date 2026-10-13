#!/bin/sh
# Builds vendor/rtl433.wasm from rtl_433 (github.com/merbanan/rtl_433, GPL-2.0-or-later) with clang's wasm32 target:
# pulse detector, slicers, bit buffer and all device decoders; no Emscripten, no libc (libc.c, stub/).
# usage: tools/rtl433/build.sh /path/to/rtl_433   (commit 80f7bcc was used)
set -e
SRC=${1:?path to an rtl_433 checkout}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
CFLAGS="--target=wasm32 -O2 -ffreestanding -fsigned-char -w -I$HERE/stub -I$SRC/include -DNDEBUG"
CORE="bitbuffer bit_util pulse_slicer pulse_detect pulse_detect_fsk decoder_util baseband data abuf compat_time"
for f in $CORE; do echo "$SRC/src/$f.c"; done > "$OUT/list"
ls "$SRC"/src/devices/*.c | grep -v "/flex.c$" >> "$OUT/list"
echo "$HERE/rtl433-wasm.c" >> "$OUT/list"
echo "$HERE/libc.c" >> "$OUT/list"
i=0
while read -r f; do
  i=$((i+1))
  clang $CFLAGS -c "$f" -o "$OUT/$i.o" 2> "$OUT/$i.log" &
  if [ $((i % 8)) -eq 0 ]; then wait; fi
done < "$OUT/list"
wait
cat "$OUT"/*.log | grep -E "error|warning: unused" | head -80 || true
wasm-ld --no-entry --allow-undefined --gc-sections --strip-all -z stack-size=262144 \
  --initial-memory=16777216 --max-memory=67108864 --export-memory \
  -o "$HERE/../../vendor/rtl433.wasm" "$OUT"/*.o
rm -rf "$OUT"
ls -l "$HERE/../../vendor/rtl433.wasm"
