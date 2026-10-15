// DVB-T2 BICM decoder for one FEC block: cells -> soft bits -> LDPC -> BCH -> BBFRAME bits.
#pragma once
#include "common.h"
#include "ldpc.h"
#include "ldpcq.h"
#include "bch.h"
#include "ldpc_gen.h"
#include "t2bitil_gen.h"

namespace dvbofdm {

// Constellation of one PLP (EN 302 755 §9.3), optionally rotated.
struct Cstln {
  int m = 0;                       // bits per cell
  int M = 0;
  std::vector<cf> pt;              // M points, index = label (MSB first bits)
  bool rot = false;
  float cosr = 1, sinr = 0;
  void init(int mod, bool rotated) {
    static const double L16[4] = {3, 1, -3, -1};
    static const double L64[8] = {7, 5, 1, 3, -7, -5, -1, -3};
    static const double L256[16] = {15, 13, 9, 11, 1, 3, 7, 5, -15, -13, -9, -11, -1, -3, -7, -5};
    static const double ang[4] = {29.0, 16.8, 8.6, 3.576334375};
    static const double nrm[4] = {sqrt(2.0), sqrt(10.0), sqrt(42.0), sqrt(170.0)};
    m = 2 + 2 * mod; M = 1 << m; rot = rotated;
    pt.assign(M, cf());
    for (int i = 0; i < M; i++) {
      double re, im;
      if (mod == 0) { re = (i & 2) ? -1 : 1; im = (i & 1) ? -1 : 1; }
      else if (mod == 1) { re = L16[((i & 8) >> 2) | ((i & 2) >> 1)]; im = L16[((i & 4) >> 1) | (i & 1)]; }
      else if (mod == 2) { re = L64[((i & 0x20) >> 3) | ((i & 8) >> 2) | ((i & 2) >> 1)]; im = L64[((i & 0x10) >> 2) | ((i & 4) >> 1) | (i & 1)]; }
      else { re = L256[((i & 0x80) >> 4) | ((i & 0x20) >> 3) | ((i & 8) >> 2) | ((i & 2) >> 1)]; im = L256[((i & 0x40) >> 3) | ((i & 0x10) >> 2) | ((i & 4) >> 1) | (i & 1)]; }
      cf p((float)(re / nrm[mod]), (float)(im / nrm[mod]));
      if (rotated) { double a = ang[mod] * PI / 180.0; p *= cf((float)cos(a), (float)sin(a)); }
      pt[i] = p;
    }
  }
};

struct FecInfo { int kldpc, kbch, t, rows, cols; const uint16_t *tab; };

inline bool fecInfo(bool shortFrame, int cod, FecInfo &f) {
#define ROW(KL, KB, T, NAME) f = {KL, KB, T, (int)(sizeof(NAME) / sizeof(NAME[0])), (int)(sizeof(NAME[0]) / sizeof(NAME[0][0])), &NAME[0][0]}; return true;
  if (!shortFrame) switch (cod) {
    case 0: ROW(32400, 32208, 12, LDPC_T2_1_2N)
    case 1: ROW(38880, 38688, 12, LDPC_T2_3_5N)
    case 2: ROW(43200, 43040, 10, LDPC_T2_2_3N_DVBT2)
    case 3: ROW(48600, 48408, 12, LDPC_T2_3_4N)
    case 4: ROW(51840, 51648, 12, LDPC_T2_4_5N)
    case 5: ROW(54000, 53840, 10, LDPC_T2_5_6N)
  } else switch (cod) {
    case 0: ROW(7200, 7032, 12, LDPC_T2_1_2S)
    case 1: ROW(9720, 9552, 12, LDPC_T2_3_5S_DVBT2)
    case 2: ROW(10800, 10632, 12, LDPC_T2_2_3S)
    case 3: ROW(11880, 11712, 12, LDPC_T2_3_4S)
    case 4: ROW(12600, 12432, 12, LDPC_T2_4_5S)
    case 5: ROW(13320, 13152, 12, LDPC_T2_5_6S)
  }
#undef ROW
  return false;
}

// One configured FEC chain: shortFrame, code rate index (0..5 = 1/2 3/5 2/3 3/4 4/5 5/6), modulation (0..3 = QPSK..256QAM)
class T2Fec {
 public:
  bool shortFrame = false; int cod = 0, mod = 0; bool rot = false;
  int N = 0, K = 0, kbch = 0, ncell = 0, m = 0;
  LdpcCode ldpc; LdpcQ ldpcq; bool fast = true; Bch bch; Cstln cs;
  std::vector<int> map;  // map[cell*m + k] = codeword bit carried by label bit k (MSB first)
  bool ok = false;

  bool init(bool sf, int cod_, int mod_, bool rot_) {
    shortFrame = sf; cod = cod_; mod = mod_; rot = rot_;
    FecInfo fi; if (!fecInfo(sf, cod, fi)) return false;
    N = sf ? 16200 : 64800; K = fi.kldpc; kbch = fi.kbch; m = 2 + 2 * mod; ncell = N / m;
    ldpc.build(N, K, fi.tab, fi.rows, fi.cols);
    ldpcq.build(N, K, fi.tab, fi.rows, fi.cols);
    bch.init(sf, fi.t, kbch);
    cs.init(mod, rot);
    if (rot) {
      int L = m / 2, nl = 1 << L;
      axLev.resize(nl); for (int a = 0; a < nl; a++) axLev[a] = axisLevel(a);
      order.resize(nl); for (int i = 0; i < nl; i++) order[i] = i;
      std::sort(order.begin(), order.end(), [&](int x, int y) { return axLev[x] < axLev[y]; });
      labelOf.assign((size_t)nl * nl, 0);
      static const double ang[4] = {29.0, 16.8, 8.6, 3.576334375};
      cr = (float)cos(ang[mod] * PI / 180); sr = (float)sin(ang[mod] * PI / 180);
      for (int lab = 0; lab < cs.M; lab++) {
        int ar = 0, ai = 0;
        for (int j = 0; j < L; j++) { ar |= ((lab >> (m - 1 - 2 * j)) & 1) << (L - 1 - j); ai |= ((lab >> (m - 2 - 2 * j)) & 1) << (L - 1 - j); }
        labelOf[(size_t)ar * nl + ai] = lab;
      }
    }
    buildMap();
    ok = true;
    return true;
  }

  // Cells -> LLR (positive = 0) in codeword order
  void demap(const cf *cell, const float *w, float *llr) const {
    std::vector<float> lc((size_t)ncell * m);
    if (!rot) {
      // separable: real axis labels and imaginary axis labels
      int L = m / 2;                     // bits per axis
      int nl = 1 << L;
      std::vector<float> lev(nl);
      std::vector<int> labIdx(nl);       // axis index -> level
      // axis level of index a: real-axis index composed of the odd label bits (MSB side), see Cstln::init
      for (int a = 0; a < nl; a++) lev[a] = axisLevel(a);
      for (int c = 0; c < ncell; c++) {
        float xr = cell[c].real(), xi = cell[c].imag(), ww = w[c];
        float *o = &lc[(size_t)c * m];
        axisLlr(xr, ww, lev, o, true);
        axisLlr(xi, ww, lev, o, false);
      }
    } else {
      const int L = m / 2, nl = 1 << L;
      for (int c = 0; c < ncell; c++) {
        float a = cell[c].real(), b = cell[(c + 1) % ncell].imag();
        float wa = w[c], wb = w[(c + 1) % ncell];
        float *o = &lc[(size_t)c * m];
        // undo the rotation to find the grid neighbourhood, then evaluate the exact metric on the 5x5 nearest points
        float xh = a * cr + b * sr, yh = -a * sr + b * cr;
        int px = nearestPos(xh), py = nearestPos(yh);
        float d0[8], d1[8]; float dbest = 1e30f;
        for (int k = 0; k < m; k++) { d0[k] = d1[k] = 1e30f; }
        for (int ix = std::max(0, px - 2); ix <= std::min(nl - 1, px + 2); ix++) for (int iy = std::max(0, py - 2); iy <= std::min(nl - 1, py + 2); iy++) {
          int s = labelOf[(size_t)order[ix] * nl + order[iy]];
          float dr = a - cs.pt[s].real(), di = b - cs.pt[s].imag();
          float d = wa * dr * dr + wb * di * di;
          if (d < dbest) dbest = d;
          for (int k = 0; k < m; k++) { if ((s >> (m - 1 - k)) & 1) { if (d < d1[k]) d1[k] = d; } else if (d < d0[k]) d0[k] = d; }
        }
        // points outside the 5x5 window are at least ~2.5 level spacings away
        const float sp = (axLev[order[1]] - axLev[order[0]]) * 2.5f, far = dbest + 0.5f * (wa + wb) * sp * sp;
        for (int k = 0; k < m; k++) {
          float x0 = d0[k] > 1e29f ? far : d0[k], x1 = d1[k] > 1e29f ? far : d1[k];
          o[k] = (x1 - x0) * scale_;
        }
      }
    }
    for (size_t i = 0; i < lc.size(); i++) llr[map[i]] = lc[i];
  }

  // Full decode of one FEC block. bits: kbch output bits. Returns 1 ok, 0 residual errors.
  int decode(const cf *cell, const float *w, uint8_t *bits, int maxIter, int *iters = nullptr, int *bchFixed = nullptr) {
    std::vector<float> llr(N);
    demap(cell, w, llr.data());
    std::vector<uint8_t> cw(N);
    int it = 0;
    bool ok2 = fast ? ldpcq.decode(llr.data(), cw.data(), maxIter, &it, relBeta > 0 ? relBeta : 0.08f) : ldpc.decode(llr.data(), cw.data(), maxIter, &it, alpha, beta, relBeta);
    if (iters) *iters = it;
    int fixed = bch.decode(cw.data());
    if (bchFixed) *bchFixed = fixed;
    memcpy(bits, cw.data(), kbch);
    return ok2 && fixed >= 0;
  }
  float scale_ = 4.f, alpha = 0.8f, beta = 0.f, relBeta = 0.f;
  std::vector<float> axLev; std::vector<int> order, labelOf; float cr = 1, sr = 0;
  int nearestPos(float x) const {            // position in the sorted level list of the level nearest to x
    int nl = (int)order.size(), lo = 0, hi = nl - 1;
    while (lo < hi) { int mid = (lo + hi) / 2; if (axLev[order[mid]] < x) lo = mid + 1; else hi = mid; }
    if (lo > 0 && fabsf(axLev[order[lo - 1]] - x) < fabsf(axLev[order[lo]] - x)) lo--;
    return lo;
  }

 private:
  float axisLevel(int a) const {
    static const double L16[4] = {3, 1, -3, -1};
    static const double L64[8] = {7, 5, 1, 3, -7, -5, -1, -3};
    static const double L256[16] = {15, 13, 9, 11, 1, 3, 7, 5, -15, -13, -9, -11, -1, -3, -7, -5};
    static const double nrm[4] = {sqrt(2.0), sqrt(10.0), sqrt(42.0), sqrt(170.0)};
    if (mod == 0) return (float)((a ? -1.0 : 1.0) / nrm[0]);
    if (mod == 1) return (float)(L16[a] / nrm[1]);
    if (mod == 2) return (float)(L64[a] / nrm[2]);
    return (float)(L256[a] / nrm[3]);
  }
  // axis label bits: label bit k (MSB first) belongs to the real axis when k is even (k = 0,2,..), imaginary when odd;
  // within an axis the index bit order is MSB first (a = b0<<(L-1) | b2<<(L-2) ...), as in Cstln::init
  void axisLlr(float x, float w, const std::vector<float> &lev, float *o, bool real) const {
    int L = m / 2, nl = 1 << L;
    float d0[8], d1[8];
    for (int j = 0; j < L; j++) d0[j] = d1[j] = 1e30f;
    for (int a = 0; a < nl; a++) {
      float dd = (x - lev[a]); dd = dd * dd * w;
      for (int j = 0; j < L; j++) { if ((a >> (L - 1 - j)) & 1) { if (dd < d1[j]) d1[j] = dd; } else if (dd < d0[j]) d0[j] = dd; }
    }
    for (int j = 0; j < L; j++) o[2 * j + (real ? 0 : 1)] = (d1[j] - d0[j]) * scale_;
  }

  void buildMap() {
    using namespace gr::dtv;
    dvb_framesize_t fs = shortFrame ? FECFRAME_SHORT : FECFRAME_NORMAL;
    static const dvb_code_rate_t R[6] = {C1_2, C3_5, C2_3, C3_4, C4_5, C5_6};
    static const dvb_constellation_t C[4] = {MOD_QPSK, MOD_16QAM, MOD_64QAM, MOD_256QAM};
    T2BitIl bi(fs, R[cod], C[mod]);
    map.assign(N, 0);
    if (mod == 0) { for (int i = 0; i < N; i++) map[i] = i; return; }  // pairs (b1 b0) = (c[2j], c[2j+1])
    const int *mux;
    if (mod == 1) mux = (cod == 1 && !shortFrame) ? T2BitIl::mux16_35 : T2BitIl::mux16;
    else if (mod == 2) mux = (cod == 1 && !shortFrame) ? T2BitIl::mux64_35 : T2BitIl::mux64;
    else if (!shortFrame) mux = cod == 1 ? T2BitIl::mux256_35 : cod == 2 ? T2BitIl::mux256_23 : T2BitIl::mux256;
    else mux = T2BitIl::mux256s;
    int pb = (mod == 3 && shortFrame) ? m : 2 * m;   // bits per pack
    int cells = pb / m;
    int index = 0;
    for (int d = 0; d < N / pb; d++) {
      for (int e = 0; e < pb; e++) {
        int p = pb - 1 - mux[e];                      // bit position inside the pack (0 = LSB)
        int cellIn = cells == 2 ? (p >= m ? 0 : 1) : 0;
        int pc = cells == 2 ? (p >= m ? p - m : p) : p;
        int k = m - 1 - pc;
        map[((size_t)(d * cells + cellIn)) * m + k] = bi.lookup_table[index++];
      }
    }
  }
};

}  // namespace dvbofdm
