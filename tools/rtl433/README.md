# rtl_433 as WebAssembly

`vendor/rtl433.wasm` is [rtl_433](https://github.com/merbanan/rtl_433) (GPL-2.0-or-later, commit `80f7bcc`): `pulse_detect` (OOK and FSK), `pulse_slicer`, `bitbuffer`, `baseband` and all `src/devices/*.c` except `flex.c`, built with clang's wasm32 target, without Emscripten and without a C library:

    git clone --depth 1 https://github.com/merbanan/rtl_433 && tools/rtl433/build.sh ./rtl_433

It needs clang with the wasm32 target and `wasm-ld`. To update the decoders, pull a newer rtl_433 and rebuild.

- `stub/` — headers of a tiny libc (no output; `fprintf` and friends compile to nothing), `libc.c` — memory (two arenas: persistent and per-call scratch), strings, `vsnprintf` (`%d %u %x %s %c %f %g %e`, width, precision), time. `sin`, `pow`, `tan`, … are imports of the page (`Math.*`), as for mbelib; `rt_now_ms` gives `gettimeofday()` to the two garage-door decoders.
- `rtl433-wasm.c` — the wrapper: up to 64 channels (a detector, filters and pulse buffers each), `rt_feed16` (cs16 IQ, magnitude envelope) and `rt_feed8` (cu8, amplitude envelope, exactly as rtl_433 does for files), the device table (`rt_dev_*`, enable / disable), the run of all slicers by priority as in `r_api.c`, JSON output of decoded events (`data_print_jsons_dup`) with `mod`, `freq`, `rssi`, `snr`, `noise`, `protocol` added, and the pulse trains of packets nobody recognized (`rt_unknown`).
- `modules/rt433-kernels.js` — the JS class `Rt433` around it; `modules/ism-scan-kernels.js` — the band scanner built on it.
- Checks: `node tools/test-rt433.mjs <rtl_433_tests>/tests [filter] [-v]` and `node tools/test-ismscan.mjs <rtl_433_tests>/tests`.

Not included: the flex decoder (`flex.c`, config files) and devices that need `create_fn` arguments.
