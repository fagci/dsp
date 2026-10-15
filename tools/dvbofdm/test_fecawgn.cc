// FEC chain alone: ideal cells from a clean capture + AWGN in the cell domain, failure rate versus Es/N0
#include "t2rx.h"
#include <cstdio>
#include <random>
#include <chrono>
using namespace dvbofdm;
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb"); std::vector<cf> x(4500000 + 64);
  size_t got = fread(x.data() + 64, 8, 4500000, f); fclose(f); x.resize(got + 64);
  P1 p1; L1Decoder l1; float met; int64_t pos = p1.scan(x.data(), 1 << 20, 0.3f, &met);
  P1Info pi = p1.identify(x.data(), x.size(), (int)pos, met);
  L1Pre pre; T2Setup S; S.build(pi.s2 >> 1, 5, 1, 0, 1, 0, 118, 0);
  S.build(pi.s2 >> 1, 5, 1, 0, 1, 0, 118, 0);
  T2FrameCells fc; T2Demod::run(x, 0, S, pos + 2048, pi.cfo, S.N + S.G, S.G / 2, fc);
  // L1 info taken as known for g1: pp2 (1), 1500 post cells
  pre.postSize = 1500;
  T2Stream str; buildStream(fc, pre, str);
  PlpCfg c; c.fec = 1; c.cod = 0; c.mod = 2; c.rot = 0; c.tilLen = 3; c.blocks = 139;
  std::mt19937 rng(7); std::normal_distribution<float> nd(0, 1);
  for (double snr = atof(argv[2]); snr <= atof(argv[3]) + 1e-9; snr += atof(argv[4])) {
    PlpDecoder dec; dec.configure(c); if (getenv("IT")) dec.maxIter = atoi(getenv("IT")); if (getenv("SLOW")) dec.fec.fast = false; if (getenv("RB")) { dec.fec.relBeta = atof(getenv("RB")); dec.fec.beta = 0; } if (getenv("BETA")) dec.fec.beta = atof(getenv("BETA")); if (getenv("TRUESCALE")) dec.fec.scale_ = 1.0 / pow(10, -snr / 10); if (getenv("ALPHA")) dec.fec.alpha = atof(getenv("ALPHA"));
    size_t n = (size_t)c.blocks * dec.fec.ncell;
    std::vector<cf> cells(str.cell.begin(), str.cell.begin() + n); std::vector<float> w(n, 1.f);
    double sg = sqrt(pow(10, -snr / 10) / 2);
    for (auto &z : cells) z += cf(sg * nd(rng), sg * nd(rng));
    std::vector<uint8_t> ts; auto t0 = std::chrono::steady_clock::now();
    dec.decodeFrame(cells.data(), w.data(), c.blocks, ts);
    { double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count(); printf("[%.2f s, %.1f ms/block] ", sec, 1000 * sec / dec.st.blocks); }
    printf("Es/N0 %.1f dB: blocks ok %d / %d, avg iters %.1f\n", snr, dec.st.ok, dec.st.blocks, dec.st.iters / (double)dec.st.blocks);
    fflush(stdout);
  }
}
