// LDPC decoder for the DVB-S2 / DVB-T2 / DVB-C2 irregular repeat-accumulate codes (EN 302 307, EN 302 755).
// The code is defined by a table: row r lists the parity-check offsets of the 360 information bits r*360 .. r*360+359
// (offset x for bit n of the row connects it to parity check (x + n*q) mod (N-K)); parity bits are accumulated (zigzag).
// Layered normalised min-sum, int8 messages are a later optimisation: this version is float.
#pragma once
#include "common.h"

namespace dvbofdm {

struct LdpcCode {
  int N = 0, K = 0, M = 0, q = 0;
  std::vector<int> cs;     // check start offsets into cv, size M+1
  std::vector<int> cv;     // variable index of every edge, grouped by check
  // tab: rows of [count, x1..xcount] padded to `cols` entries
  template <typename T>
  void build(int n, int k, const T *tab, int rows, int cols) {
    N = n; K = k; M = n - k; q = M / 360;
    std::vector<std::vector<int>> chk(M);
    for (int r = 0; r < rows; r++) {
      int cnt = tab[r * cols];
      for (int i = 0; i < 360; i++) {
        int v = r * 360 + i;
        if (v >= K) break;
        for (int c = 1; c <= cnt; c++) chk[(tab[r * cols + c] + (int64_t)i * q) % M].push_back(v);
      }
    }
    cs.assign(M + 1, 0); cv.clear();
    for (int c = 0; c < M; c++) {
      cs[c] = (int)cv.size();
      for (int v : chk[c]) cv.push_back(v);
      cv.push_back(K + c);
      if (c > 0) cv.push_back(K + c - 1);
    }
    cs[M] = (int)cv.size();
  }

  // llr > 0 means bit 0. Returns true when all checks are satisfied. bits: N hard decisions out.
  bool decode(const float *llr, uint8_t *bits, int maxIter, int *iters = nullptr, float alpha = 0.8f) const {
    std::vector<float> L(llr, llr + N), R(cv.size(), 0.f);
    int it = 0;
    bool ok = false;
    {
      ok = true;                                   // clean channel: all checks already hold
      for (int c = 0; c < M && ok; c++) {
        int p = 0;
        for (int e = cs[c]; e < cs[c + 1]; e++) p ^= L[cv[e]] < 0;
        if (p) ok = false;
      }
      if (ok) { for (int i = 0; i < N; i++) bits[i] = L[i] < 0; if (iters) *iters = 0; return true; }
    }
    for (; it < maxIter; it++) {
      for (int c = 0; c < M; c++) {
        int s = cs[c], t = cs[c + 1];
        float m1 = 1e30f, m2 = 1e30f; int im = -1; uint32_t sg = 0;
        float q[64]; bool qs[64];
        for (int e = s; e < t; e++) {
          float v = L[cv[e]] - R[e];
          q[e - s] = v; qs[e - s] = v < 0;
          float a = fabsf(v);
          if (v < 0) sg ^= 1;
          if (a < m1) { m2 = m1; m1 = a; im = e - s; } else if (a < m2) m2 = a;
        }
        for (int e = s; e < t; e++) {
          float mag = (e - s == im ? m2 : m1) * alpha;
          bool neg = (sg ^ qs[e - s]) & 1;
          float r = neg ? -mag : mag;
          R[e] = r; L[cv[e]] = q[e - s] + r;
        }
      }
      // syndrome
      ok = true;
      for (int c = 0; c < M && ok; c++) {
        int p = 0;
        for (int e = cs[c]; e < cs[c + 1]; e++) p ^= L[cv[e]] < 0;
        if (p) ok = false;
      }
      if (ok) { it++; break; }
    }
    for (int i = 0; i < N; i++) bits[i] = L[i] < 0;
    if (iters) *iters = it;
    return ok;
  }
};

}  // namespace dvbofdm
