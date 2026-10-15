// Rotated / plain QAM demapper against the transmitter's constellation: noise free hard decisions and a noisy bit error check
#include "t2fec.h"
#include <cstdio>
#include <random>
using namespace dvbofdm;
int main() {
  std::mt19937 rng(3); std::normal_distribution<float> nd(0, 1); int bad = 0;
  for (int mod = 0; mod < 4; mod++) for (int rot = 0; rot < 2; rot++) {
    T2Fec f; f.init(false, 0, mod, rot);
    int nc = f.ncell, m = f.m;
    std::vector<int> lab(nc); for (auto &l : lab) l = rng() % f.cs.M;
    std::vector<cf> cell(nc); std::vector<float> w(nc, 1.f);
    for (int j = 0; j < nc; j++) {
      if (!rot) cell[j] = f.cs.pt[lab[j]];
      else cell[j] = cf(f.cs.pt[lab[j]].real(), f.cs.pt[lab[(j + nc - 1) % nc]].imag());   // Q delayed by one cell
    }
    for (double snrdb : {100.0, 18.0}) {
      double sg = sqrt(pow(10, -snrdb / 10) / 2);
      std::vector<cf> rx = cell; for (auto &z : rx) z += cf(sg * nd(rng), sg * nd(rng));
      std::vector<float> llr(f.N);
      f.scale_ = 1; f.demap(rx.data(), w.data(), llr.data());
      long err = 0, tot = 0;
      for (int j = 0; j < nc; j++) for (int k = 0; k < m; k++) {
        int bit = (lab[j] >> (m - 1 - k)) & 1; int cw = f.map[(size_t)j * m + k];
        err += (llr[cw] < 0) != (bit == 1); tot++;
      }
      printf("mod %d rot %d snr %.0f: bit errors %ld / %ld\n", mod, rot, snrdb, err, tot);
      if (snrdb > 50 && err) bad++;
    }
  }
  printf(bad ? "FAILED\n" : "all ok\n"); return bad;
}
