#!/bin/sh
# Builds vendor/codec2.wasm (Codec 2 modes 3200 / 1600 for M17) with clang's wasm32 target; no Emscripten, no libc.
# usage: tools/codec2/build.sh /path/to/codec2 (checkout of github.com/drowe67/codec2)   - needs gcc for the codebook generator
set -e
SRC=${1:?path to a codec2 checkout}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
gcc -O1 -w "$SRC/src/generate_codebook.c" -lm -o "$OUT/gencb"
CB="$SRC/src/codebook"
"$OUT/gencb" lsp_cb $CB/lsp1.txt $CB/lsp2.txt $CB/lsp3.txt $CB/lsp4.txt $CB/lsp5.txt $CB/lsp6.txt $CB/lsp7.txt $CB/lsp8.txt $CB/lsp9.txt $CB/lsp10.txt > "$OUT/codebook.c"
"$OUT/gencb" lsp_cbd $CB/dlsp1.txt $CB/dlsp2.txt $CB/dlsp3.txt $CB/dlsp4.txt $CB/dlsp5.txt $CB/dlsp6.txt $CB/dlsp7.txt $CB/dlsp8.txt $CB/dlsp9.txt $CB/dlsp10.txt > "$OUT/codebookd.c"
"$OUT/gencb" lsp_cbjmv $CB/lspjmv1.txt $CB/lspjmv2.txt $CB/lspjmv3.txt > "$OUT/codebookjmv.c"
"$OUT/gencb" ge_cb $CB/gecb.txt > "$OUT/codebookge.c"
"$OUT/gencb" newamp1vq_cb $CB/train_120_1.txt $CB/train_120_2.txt > "$OUT/codebooknewamp1.c"
"$OUT/gencb" newamp1_energy_cb $CB/newamp1_energy_q.txt > "$OUT/codebooknewamp1_energy.c"
"$OUT/gencb" newamp2vq_cb $CB/codes_450.txt > "$OUT/codebooknewamp2.c"
"$OUT/gencb" newamp2_energy_cb $CB/newamp2_energy_q.txt > "$OUT/codebooknewamp2_energy.c"
S="$SRC/src"
clang --target=wasm32 -O2 -nostdlib -ffreestanding -fsigned-char -w -I"$HERE/stub" -I"$HERE" -I"$S" -I"$OUT" -DCODEC2_MODE_EN_DEFAULT=1 \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export=c2_bits -Wl,--export=c2_pcm -Wl,--export=c2_new -Wl,--export=c2_free \
  -Wl,--export=c2_samples -Wl,--export=c2_decode -Wl,--strip-all -Wl,-z,stack-size=131072 \
  -o "$HERE/../../vendor/codec2.wasm" "$HERE/codec2-wasm.c" \
  "$S/codec2.c" "$S/codec2_fft.c" "$S/kiss_fft.c" "$S/kiss_fftr.c" "$S/interp.c" "$S/lpc.c" "$S/lsp.c" "$S/nlp.c" "$S/phase.c" "$S/postfilter.c" \
  "$S/quantise.c" "$S/sine.c" "$S/pack.c" "$S/mbest.c" "$S/newamp1.c" "$S/lpcnet_freq.c" "$S/golay23.c" \
  "$OUT/codebook.c" "$OUT/codebookd.c" "$OUT/codebookjmv.c" "$OUT/codebookge.c" "$OUT/codebooknewamp1.c" "$OUT/codebooknewamp1_energy.c" "$OUT/codebooknewamp2.c" "$OUT/codebooknewamp2_energy.c"
rm -rf "$OUT"
ls -l "$HERE/../../vendor/codec2.wasm"
