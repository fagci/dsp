// Native test driver: t2rx_file <cfile> <out.ts> [bw MHz] [plp]
#include "t2rx.h"
#include <cstdio>
#include <chrono>
using namespace dvbofdm;
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb"); FILE *o = fopen(argv[2], "wb");
  T2Receiver rx; if (argc > 3) rx.cfg.bwMhz = atof(argv[3]); if (argc > 4) rx.cfg.plp = atoi(argv[4]);
  std::vector<cf> chunk(1 << 16); size_t total = 0;
  auto t0 = std::chrono::steady_clock::now();
  uint64_t lastFrames = 0;
  while (true) {
    size_t n = fread(chunk.data(), 8, chunk.size(), f); if (!n) break;
    total += n; rx.feed(chunk.data(), n);
    if (!rx.ts.empty()) { fwrite(rx.ts.data(), 1, rx.ts.size(), o); rx.ts.clear(); }
    if (rx.st.frames != lastFrames) { lastFrames = rx.st.frames;
      fprintf(stderr, "frame %llu lock %d fecOk %d fft %d gi %d plp %d mod %d cod %d snr %.1f dB cfo %.1f Hz delay %.1f blocks %llu/%llu fixed %llu pk %llu %s\n", (unsigned long long)rx.st.frames, rx.st.lock, rx.st.fecOk, rx.st.fftSize, rx.st.giIdx, rx.st.plpId, rx.st.mod, rx.st.cod, rx.st.snrDb, rx.st.cfoHz, rx.st.delay, (unsigned long long)rx.st.blocksOk, (unsigned long long)rx.st.blocks, (unsigned long long)rx.st.blocksFix, (unsigned long long)rx.st.packets, rx.st.text.c_str()); }
  }
  double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  fprintf(stderr, "samples %zu in %.2f s (%.2f MS/s), frames %llu ok %llu, blocks %llu/%llu, packets %llu\n", total, sec, total / sec / 1e6, (unsigned long long)rx.st.frames, (unsigned long long)rx.st.framesOk, (unsigned long long)rx.st.blocksOk, (unsigned long long)rx.st.blocks, (unsigned long long)rx.st.packets);
  fclose(o);
}
