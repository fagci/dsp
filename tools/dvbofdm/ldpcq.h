// Fast LDPC decoder for the 360-lifted IRA codes of DVB-S2 / T2 (layered offset min-sum, int8 messages).
// Layer j holds the 360 checks j + q*m, m = 0..359. An information bit (row r, index i) with table entry x belongs to layer x mod q
// and lane m = (i + x div q) mod 360, so every connection is a rotation of a 360-vector; the lanes are processed together
// (compilers vectorise the byte loops; wasm gets simd128 with -msimd128).
#pragma once
#include "common.h"

namespace dvbofdm {

class LdpcQ {
 public:
  int N = 0, K = 0, M = 0, q = 0, rows = 0;
  struct Conn { int var; int shift; bool chainStart; };
  std::vector<std::vector<Conn>> layer;   // per layer: info connections, then the two parity connections
  static const int LV = 368;              // padded vector length

  template <typename T>
  void build(int n, int k, const T *tab, int nrows, int cols) {
    N = n; K = k; M = n - k; q = M / 360; rows = k / 360;
    layer.assign(q, std::vector<Conn>());
    for (int r = 0; r < nrows && r < rows; r++) {
      int cnt = tab[r * cols];
      for (int c = 1; c <= cnt; c++) {
        int x = tab[r * cols + c];
        layer[x % q].push_back({r, x / q, false});
      }
    }
    for (int j = 0; j < q; j++) {
      layer[j].push_back({rows + j, 0, false});                    // p_c
      if (j > 0) layer[j].push_back({rows + j - 1, 0, false});     // p_{c-1}
      else layer[j].push_back({rows + q - 1, 1, true});            // p_{c-1} of lane m is p_{q-1, m-1}; lane 0 has none
    }
    maxDeg = 0; for (auto &l : layer) maxDeg = std::max<int>(maxDeg, (int)l.size());
    V.assign((size_t)(rows + q) * LV, 0);
    nconn = 0; for (auto &l : layer) nconn += l.size();
    R.assign((size_t)nconn * LV, 0);
    Qb.assign((size_t)maxDeg * LV, 0);
    Tb.assign((size_t)maxDeg * LV, 0);
  }

  // llr > 0: bit 0. Returns true when all checks hold. bits: N hard decisions out. relBeta: offset relative to the mean |llr|.
  bool decode(const float *llr, uint8_t *bits, int maxIter, int *iters = nullptr, float relBeta = 0.08f) {
    double mean = 0; for (int i = 0; i < N; i++) mean += fabsf(llr[i]); mean /= N;
    float g = mean > 1e-9 ? (float)(10.0 / mean) : 1.f;
    // load: info bit v = r*360+i ; parity bit K + c with c = j + q*m  ->  parity vector j, lane m
    for (int r = 0; r < rows; r++) for (int i = 0; i < 360; i++) V[(size_t)r * LV + i] = clampq(llr[r * 360 + i] * g);
    for (int j = 0; j < q; j++) for (int m = 0; m < 360; m++) V[(size_t)(rows + j) * LV + m] = clampq(llr[K + j + (size_t)q * m] * g);
    std::fill(R.begin(), R.end(), (int8_t)0);
    int8_t beta = relBeta > 0 ? 1 : 0;
    int it = 0;
    bool ok = syndrome();
    if (!ok) {
      for (; it < maxIter; it++) {
        int flips = 0; bool par = true;
        size_t cbase = 0;
        for (int j = 0; j < q; j++) { flips += layerStep(j, cbase, beta, par); cbase += layer[j].size(); }
        if (flips == 0 && par) { ok = true; it++; break; }
        if (it >= 1 && flips == 0) { ok = syndrome(); if (ok) { it++; break; } }
      }
    }
    for (int r = 0; r < rows; r++) for (int i = 0; i < 360; i++) bits[r * 360 + i] = V[(size_t)r * LV + i] < 0;
    for (int j = 0; j < q; j++) for (int m = 0; m < 360; m++) bits[K + j + (size_t)q * m] = V[(size_t)(rows + j) * LV + m] < 0;
    if (iters) *iters = it;
    return ok;
  }

 private:
  int maxDeg = 0; size_t nconn = 0;
  std::vector<int8_t> V, R, Qb, Tb;

  static int8_t clampq(float v) { int x = (int)lrintf(v); return (int8_t)(x > 63 ? 63 : x < -63 ? -63 : x); }

  static void rotIn(const int8_t *base, int s, int8_t *t) {          // t[m] = base[(m - s) mod 360]
    if (s == 0) { memcpy(t, base, 360); return; }
    memcpy(t + s, base, 360 - s); memcpy(t, base + 360 - s, s);
  }
  static void rotOut(const int8_t *t, int s, int8_t *base) {         // base[(m - s) mod 360] = t[m]
    if (s == 0) { memcpy(base, t, 360); return; }
    memcpy(base, t + s, 360 - s); memcpy(base + 360 - s, t, s);
  }

  bool syndrome() {
    int8_t t[LV];
    for (int j = 0; j < q; j++) {
      uint8_t p[LV]; memset(p, 0, sizeof p);
      for (const Conn &c : layer[j]) {
        rotIn(&V[(size_t)c.var * LV], c.shift, t);
        if (c.chainStart) t[0] = 0x7f;
        for (int m = 0; m < 360; m++) p[m] ^= (uint8_t)t[m] >> 7;
      }
      for (int m = 0; m < 360; m++) if (p[m]) return false;
    }
    return true;
  }

  // One layer; returns the number of hard decision flips. par is cleared when a check of the layer is violated afterwards.
  int layerStep(int j, size_t cbase, int8_t beta, bool &par) {
    const std::vector<Conn> &cs = layer[j];
    const int D = (int)cs.size();
    int8_t mn1[LV], mn2[LV]; uint8_t sg[LV], ix[LV];
    for (int m = 0; m < LV; m++) { mn1[m] = 127; mn2[m] = 127; sg[m] = 0; ix[m] = 0; }
    for (int e = 0; e < D; e++) {
      int8_t *t = &Tb[(size_t)e * LV], *qv = &Qb[(size_t)e * LV];
      const int8_t *Re = &R[(cbase + e) * LV];
      rotIn(&V[(size_t)cs[e].var * LV], cs[e].shift, t);
      if (cs[e].chainStart) t[0] = 127;
      for (int m = 0; m < 360; m++) {
        int v = t[m] - Re[m];
        v = v > 127 ? 127 : v < -127 ? -127 : v;
        qv[m] = (int8_t)v;
        int a = v < 0 ? -v : v;
        sg[m] ^= (uint8_t)v >> 7;
        bool lt1 = a < mn1[m];
        mn2[m] = lt1 ? mn1[m] : (a < mn2[m] ? (int8_t)a : mn2[m]);
        ix[m] = lt1 ? (uint8_t)e : ix[m];
        mn1[m] = lt1 ? (int8_t)a : mn1[m];
      }
    }
    int flips = 0;
    uint8_t chk[LV]; memset(chk, 0, sizeof chk);
    for (int e = 0; e < D; e++) {
      int8_t *t = &Tb[(size_t)e * LV], *qv = &Qb[(size_t)e * LV];
      int8_t *Re = &R[(cbase + e) * LV];
      const bool cstart = cs[e].chainStart;
      for (int m = 0; m < 360; m++) {
        int mag = (ix[m] == e ? mn2[m] : mn1[m]) - beta; mag = mag < 0 ? 0 : mag;
        bool neg = ((sg[m] ^ ((uint8_t)qv[m] >> 7)) & 1);
        int r = neg ? -mag : mag;
        Re[m] = (int8_t)r;
        int l = qv[m] + r; l = l > 127 ? 127 : l < -127 ? -127 : l;
        flips += ((t[m] ^ l) < 0) ? 1 : 0;          // hard decision changed (t[m] still holds the old L)
        t[m] = (int8_t)l;
        chk[m] ^= (uint8_t)l >> 7;
      }
      if (cstart) {                                   // lane 0 has no p_{c-1}: undo its contribution, keep the sentinel
        int8_t l0 = t[0];
        if ((127 ^ l0) < 0) flips--;
        chk[0] ^= (uint8_t)l0 >> 7;
        t[0] = 127; Re[0] = 0;
      }
    }
    for (int m = 0; m < 360; m++) if (chk[m]) par = false;
    int8_t keep = 0; bool fixLane = false;
    for (int e = 0; e < D; e++) {
      int8_t *base = &V[(size_t)cs[e].var * LV];
      if (cs[e].chainStart) { keep = base[359]; fixLane = true; }
      rotOut(&Tb[(size_t)e * LV], cs[e].shift, base);
      if (cs[e].chainStart && fixLane) base[359] = keep;
    }
    return flips;
  }
};

}  // namespace dvbofdm
