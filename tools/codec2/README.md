# Codec 2 as WebAssembly

`vendor/codec2.wasm` is [Codec 2](https://github.com/drowe67/codec2) (LGPL 2.1; built from the 1.2.0 sources) with modes 3200 and 1600, the ones M17 uses, decoder and encoder (`c2_decode`, `c2_encode`):

    git clone https://github.com/drowe67/codec2 && tools/codec2/build.sh ./codec2

Needs clang with the wasm32 target and `wasm-ld`, plus gcc for Codec 2's codebook generator (`generate_codebook`, which turns the `.txt` codebooks into C). `stub/` holds tiny replacements for the C library headers; `codec2-wasm.c` is the wrapper (a bump allocator instead of malloc, one decoder handle per stream). The transcendental functions are imports the page fills with `Math.*`.

LGPL: the source of the library is the upstream repository above (unmodified); rebuild the module with the script to get a version of your own.
