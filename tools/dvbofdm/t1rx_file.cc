// Native test driver: t1rx_file <cfile> <out.ts> [bw MHz]
#include "t1rx.h"
#include <cstdio>
#include <chrono>
using namespace dvbofdm;
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb"); FILE *o = fopen(argv[2], "wb");
  T1Receiver rx; if (argc > 3) rx.cfg.bwMhz = atof(argv[3]);
  std::vector<cf> chunk(1 << 16); size_t total = 0, lastSym = 0;
  auto t0 = std::chrono::steady_clock::now();
  while (true) {
    size_t n = fread(chunk.data(), 8, chunk.size(), f); if (!n) break;
    total += n; rx.feed(chunk.data(), n);
    if (!rx.ts.empty()) { fwrite(rx.ts.data(), 1, rx.ts.size(), o); rx.ts.clear(); }
    if (rx.st.symbols - lastSym >= 400) { lastSym = rx.st.symbols;
      const T1Status &s = rx.st;
      fprintf(stderr, "sym %llu lock %d tps %d fft %d gi %d mod %d cod %d snr %.1f cfo %.1f Hz lead %.1f sfo %.1f coh %.2f pk %llu rsfix %llu rsfail %llu %s\n", (unsigned long long)s.symbols, s.lock, s.tps, s.fftSize, s.giIdx, s.mod, s.cod, s.snrDb, s.cfoHz, s.delay, s.sfoPpm, s.coh, (unsigned long long)s.packets, (unsigned long long)s.rsFixed, (unsigned long long)s.rsFail, s.text.c_str()); }
  }
  double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  const T1Status &s = rx.st;
  fprintf(stderr, "samples %zu in %.2f s (%.2f MS/s), symbols %llu packets %llu rsfix %llu rsfail %llu tps %llu\n", total, sec, total / sec / 1e6, (unsigned long long)s.symbols, (unsigned long long)s.packets, (unsigned long long)s.rsFixed, (unsigned long long)s.rsFail, (unsigned long long)s.tpsOk);
  fclose(o);
}
