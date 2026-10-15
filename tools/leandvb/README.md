# leandvb as WebAssembly

`vendor/leandvb.wasm` is the DVB-S / DVB-S2 demodulator of [LeanSDR](https://github.com/pabr/leansdr) (GPL-3.0-or-later, commit `e6416aa323fdfa553b7cb1420c3291acaeb7b65a`):

    git clone https://github.com/pabr/leansdr && git -C leansdr checkout e6416aa323fdfa553b7cb1420c3291acaeb7b65a
    tools/leandvb/build.sh ./leansdr

Needs clang with the wasm32-wasi target and wasi-libc + libc++ for wasm32 (Ubuntu: `wasi-libc libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32`).

- `leandvb-wasm.patch` — the changes to `src/apps/leandvb.cc`: the receiver objects that lived on `run()`'s stack become `static`, `run()` returns after building the pipeline instead of reading stdin to the end, `scheduler` is global (`g_sch`).
- `leandvb-wasm.cc` — the wrapper: `read` / `write` are replaced by memory buffers (fd 0 input IQ, fd 1 transport stream, fd 3 status lines), `lds_init(args)` takes leandvb's command line, `lds_feed(bytes)` steps the scheduler.
- Glue: `modules/leandvb-kernels.js` (`LeanDvb`, with the few WASI calls libc wants), test `node tools/test-leandvb.mjs ./leansdr`.
