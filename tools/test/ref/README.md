Reference vectors for `cases/fsk4.mjs` come from real code of MMDVMHost (g4klx, GPLv2): classes are built into small
programs that print encoder output for known payloads. `p25ref.cpp` builds against MMDVMHost with `Log.h` and `Utils.cpp`
replaced by empty stubs:

    g++ -std=c++11 -DUSE_P25 -DUSE_DMR -DUSE_YSF -DUSE_NXDN -DUSE_DSTAR -I. p25ref.cpp P25Data.cpp P25NID.cpp P25Trellis.cpp \
        P25Utils.cpp RS634717.cpp BCH.cpp Golay24128.cpp Hamming.cpp CRC.cpp Utils.cpp P25LowSpeedData.cpp -o p25ref

Its `name:hex` output lines go to `data/fsk4-vectors.json`.
