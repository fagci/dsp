# mbelib as WebAssembly

`vendor/mbelib.wasm` is [mbelib](https://github.com/szechyjs/mbelib) (ISC licence, commit `9a04ed5c78176a9965f3d43f7aa1b1f5330e771f`) built without Emscripten or a C library:

    git clone https://github.com/szechyjs/mbelib && tools/mbelib/build.sh ./mbelib

It needs clang with the wasm32 target and `wasm-ld`. `stub/` holds tiny replacements for `stdio.h` / `stdlib.h` / `math.h` (mbelib only prints debug output; `cosf`, `powf`, `exp`, `log` are imports the page fills with `Math.*`), `mbelib-wasm.c` is the wrapper: one handle per decoder state, a frame buffer, a 160-sample output buffer.

Note on patents: IMBE / AMBE / AMBE+2 are DVSI vocoders; see the mbelib README. The module is optional — the Vocoder node reports that it is missing when the file is not there.
