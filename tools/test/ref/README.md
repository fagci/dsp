Reference vectors for `cases/fsk4.mjs` come from real code of MMDVMHost (g4klx, GPLv2): classes are built into small
programs that print encoder output for known payloads. `p25ref.cpp` builds against MMDVMHost with `Log.h` and `Utils.cpp`
replaced by empty stubs:

    g++ -std=c++11 -DUSE_P25 -DUSE_DMR -DUSE_YSF -DUSE_NXDN -DUSE_DSTAR -I. p25ref.cpp P25Data.cpp P25NID.cpp P25Trellis.cpp \
        P25Utils.cpp RS634717.cpp BCH.cpp Golay24128.cpp Hamming.cpp CRC.cpp Utils.cpp P25LowSpeedData.cpp -o p25ref

Its `name:hex` output lines go to `data/fsk4-vectors.json`.

`nxdnref.cpp` (NXDN frames: LICH, SACCH, FACCH1, UDCH, scrambler) builds the same way against NXDNLICH / NXDNSACCH / NXDNFACCH1 /
NXDNUDCH / NXDNCRC / NXDNConvolution / Sync. Note: MMDVMHost computes the LICH parity bit only for the RDCH / UDCH codes it
uses; the parity here is the XOR of the four high bits (as in dsd-fme), so the RTCH frame C is only used for its FACCH1 halves.

`m17ref.c` is built against libm17 (M17-Project, GPLv2+): `gcc -O1 -I. m17ref.c m17.c */*.c -lm` (without `unit_tests`). It prints the
LSF fields and every frame type as 192 dibits (0 = +1, 1 = +3, 2 = −1, 3 = −3), sync burst included.

`ysfref.cpp` builds against YSFFICH / YSFPayload / YSFConvolution / CRC / Sync / Golay24128 / Hamming / AMBEFEC (`#define private public`
gives it access to the raw FICH bytes). It prints a FICH encoded by MMDVMHost, a header frame from `writeHeader` and a V/D mode 2
frame whose DCH / VCH blocks are built by the same code MMDVMHost uses to regenerate them.

`dstarref.cpp` copies `txHeader()` and its interleave / scramble tables out of the MMDVM firmware (g4klx/MMDVM, `DStarTX.cpp`) — the header
FEC is done there, not in MMDVMHost — and uses MMDVMHost's `CDStarSlowData` for the slow-data text and `CCRC::addCCITT161` for the CRC.

`dpmrref.cpp` is assembled from dsd-fme (lwvmobile, ISC): the dPMR scrambler, 12×6 de-interleaver, Hamming(12,8), CRC-7 and address conversion
are copied verbatim (line ranges of `dpmr_voice.c` and `fec.c`) around a small `main`; dsd-fme has no dPMR encoder, so whole frames are only
checked generator → decoder. `g++ -std=gnu++14 dpmrref.cpp`.

`tdulcref.cpp` links dsd-fme's `p25p1_check_hdu.cpp` / `p25p1_check_ldu.cpp` / `Hamming.cpp` (`-I include -I src`) and prints its Golay(24,12) and
RS(24,12,13) encoders on random data. dsd-fme keeps the hexbits in reverse of the transmission order; the test reverses them back.

`cacref.c` (NXDN control channel CAC) takes 300-bit CAC frames on stdin (0/1 text) and runs them through the dsd-fme code:
`nxdn_soft_decision_viterbi` from `soft_viterbi_k5.c` (built with a stub `dsd.h`), `PERM_12_25`, the CAC puncture pattern and `crc16cac`. It
prints the CRC (0 = good) and the 171 decoded bits. `cac_*` vectors are frames encoded by `nxdnChEncode(NXDN_CH.cac, …)` that it decodes with
CRC 0 and the same data bits.

`pduref.cpp` builds against MMDVMHost `P25Trellis` (with a stub `Log.h`): it prints the rate ¾ trellis encoding of an 18-byte block, plus the CRC-32 (`crc32mbf`) and CRC-9 (`ComputeCrc9Bit`) functions copied from dsd-fme over fixed data. Vectors `tr34`, `crc32mbf`, `crc9`.

`dpmrhdrref.cpp` builds inside a dsdcc checkout (f4exb, GPLv3; `g++ -std=c++11 -w -I. dpmrhdrref.cpp fec.cpp`). It encodes dPMR header words the way dsdcc's `processHIn` decodes them (LFSR scrambler, `dI120` interleave, `Hamming_12_8::encode`, CRC-8); its dibit strings are the `dpmr_hdr` vectors. The FS1 / FS3 / FS4 sync patterns are taken from dsdcc's `dsd_sync.cpp`; the packet data header (FS4) layout is table 5.45 of ETSI TS 102 658 (same fields as the FS1 header: HT, called ID, own ID, M, V, F, EP, PM, MI, CRC-8 + FEC).
