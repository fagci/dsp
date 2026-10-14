# Reference for the DVB tuner port

`tuner_ref.c` is the R820T / R828D tuner code of the Linux kernel (`drivers/media/tuners/r820t.c`, GPL-2.0-or-later, Mauro Carvalho Chehab):
`set_mux`, `set_pll`, `sysfreq_sel`, `set_tv_standard` and the register helpers, copied as they are, with a few lines of stubs around them
(kernel types, a fake I2C bus that prints every read and write, canned replies for the reads).

    gcc -O1 -w -o tools/dvb-ref/tuner_ref tools/dvb-ref/tuner_ref.c
    node tools/test-dvb.mjs tools/dvb-ref/tuner_ref

`test-dvb.mjs` runs the JavaScript port (`modules/dvb-kernels.js`) over the same inputs and compares the sequence of I2C operations
with this program's output.
