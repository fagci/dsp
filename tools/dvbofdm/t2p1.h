// DVB-T2 P1 preamble: detection (delay correlation, CFO-tolerant), S1/S2 identification, fine timing.
// P1 = C(542) | A(1024) | B(482); C and B are copies of the head and tail of A shifted up by one bin (EN 302 755 §7.4.1.4).
#pragma once
#include "common.h"
#include "p1_gen.h"

namespace dvbofdm {

struct P1Info {
  bool ok = false;
  int64_t start = 0;      // absolute index of the first sample of P1
  double cfo = 0;         // carrier offset, rad / sample (signal frequency minus nominal)
  int s1 = -1, s2 = -1;   // S1 (0..7), S2 (0..15): S2 = field1 << 1 | field2
  float metric = 0, idScore = 0;
};

class P1 {
 public:
  P1() : fft_(1024) { buildTemplate(); }
  // Window correlation metric for every start position in [0, n-2048); returns best position or -1.
  // x is read-only; base is the absolute index of x[0]. Threshold is on the normalised metric (0..1).
  int64_t scan(const cf *x, int n, float thr, float *bestMetric = nullptr);
  // Identify S1/S2 and refine timing/CFO of a P1 found near position `pos` in x (needs pos+2048+16 samples).
  P1Info identify(const cf *x, int n, int pos, float coarseMetric);

  // Time-domain template of the A part for (s1,s2), for fine correlation
  const cf *tmpl() const { return aTime_; }
  void expectedBits(int s1, int s2, uint8_t *bits384) const;

 private:
  void buildTemplate();
  Fft fft_;
  int8_t rnd_[384];
  cf aTime_[1024];
  std::vector<double> pc_;  // scratch prefix sums
};

inline void P1::buildTemplate() {
  int sr = 0x4e46;
  for (int i = 0; i < 384; i++) {
    int b = ((sr) ^ (sr >> 1)) & 1;
    rnd_[i] = b == 0 ? 1 : -1;
    sr >>= 1;
    if (b) sr |= 0x4000;
  }
}

inline void P1::expectedBits(int s1, int s2, uint8_t *bits) const {
  int k = 0;
  for (int i = 0; i < 8; i++) for (int j = 7; j >= 0; j--) bits[k++] = (P1_S1[s1][i] >> j) & 1;
  for (int i = 0; i < 32; i++) for (int j = 7; j >= 0; j--) bits[k++] = (P1_S2[s2][i] >> j) & 1;
  for (int i = 0; i < 8; i++) for (int j = 7; j >= 0; j--) bits[k++] = (P1_S1[s1][i] >> j) & 1;
}

inline int64_t P1::scan(const cf *x, int n, float thr, float *bestMetric) {
  const int L = 2048, W1 = 542, W2 = 482;
  if (n < L + 8) return -1;
  const double phi = 2 * PI / 1024;
  // y[i] = x[i] conj(x[i+542]) e^{-j phi i};  z[i] = x[i] conj(x[i-482]) e^{-j phi i}
  const int m = n - L;  // candidate starts 0..m-1
  std::vector<double> ey(n + 1, 0.0);  // prefix of |x|^2
  for (int i = 0; i < n; i++) ey[i + 1] = ey[i] + cabs2(x[i]);
  std::vector<std::complex<double>> py(n + 1), pz(n + 1);
  py[0] = pz[0] = 0;
  for (int i = 0; i < n; i++) {
    std::complex<double> w(cos(phi * (i & 1023)), -sin(phi * (i & 1023)));
    std::complex<double> y = (i + W1 < n) ? std::complex<double>(x[i]) * std::conj(std::complex<double>(x[i + W1])) * w : 0.0;
    std::complex<double> z = (i - W2 >= 0) ? std::complex<double>(x[i]) * std::conj(std::complex<double>(x[i - W2])) * w : 0.0;
    py[i + 1] = py[i] + y; pz[i + 1] = pz[i] + z;
  }
  float best = 0; int64_t bp = -1;
  for (int p = 0; p < m; p++) {
    double s1 = std::abs(py[p + W1] - py[p]);
    double s2 = std::abs(pz[p + L] - pz[p + 1566]);
    double e1 = sqrt((ey[p + W1] - ey[p]) * (ey[p + 2 * W1] - ey[p + W1]));
    double e2 = sqrt((ey[p + L] - ey[p + 1566]) * (ey[p + 1566] - ey[p + 1084]));
    double d = e1 + e2;
    float r = d > 1e-20 ? (float)((s1 + s2) / d) : 0.f;
    if (r > best) { best = r; bp = p; }
  }
  if (bestMetric) *bestMetric = best;
  return best >= thr ? bp : -1;
}

inline P1Info P1::identify(const cf *x, int n, int pos, float coarseMetric) {
  P1Info r; r.metric = coarseMetric;
  const int W1 = 542, W2 = 482;
  if (pos < 16 || pos + 2048 + 16 > n) return r;
  const double phi = 2 * PI / 1024;
  // fractional CFO from the two correlations: arg(M1) = -542 eps, arg(M2) = +482 eps
  std::complex<double> m1 = 0, m2 = 0;
  for (int k = 0; k < W1; k++) {
    double a = -phi * k;
    m1 += std::complex<double>(x[pos + k]) * std::conj(std::complex<double>(x[pos + W1 + k])) * std::complex<double>(cos(a), sin(a));
  }
  for (int k = 0; k < W2; k++) {
    double a = -phi * (542 + k);
    m2 += std::complex<double>(x[pos + 1566 + k]) * std::conj(std::complex<double>(x[pos + 1084 + k])) * std::complex<double>(cos(a), sin(a));
  }
  double e1 = -std::arg(m1) / W1, e2 = std::arg(m2) / W2;
  // both are valid modulo 2pi/542 and 2pi/482; take the mean of the closest pair
  double eps = 0.5 * (e1 + e2);
  double best = 1e9;
  for (int a = -3; a <= 3; a++) for (int b = -3; b <= 3; b++) {
    double ca = e1 + 2 * PI * a / W1, cb = e2 + 2 * PI * b / W2;
    if (fabs(ca - cb) < best) { best = fabs(ca - cb); eps = 0.5 * (ca + cb); }
  }
  // derotated A part, spectrum, integer shift search, DBPSK pattern match
  cf buf[1024];
  for (int k = 0; k < 1024; k++) {
    double a = -eps * (542 + k);
    buf[k] = x[pos + 542 + k] * cf((float)cos(a), (float)sin(a));
  }
  fft_.run(buf);
  int bin[384];
  for (int i = 0; i < 384; i++) bin[i] = (P1_ACTIVE[i] + 86 + 512) & 1023;
  double bestSc = -1; int bs = 0;
  for (int s = -120; s <= 120; s++) {
    double sc = 0;
    for (int i = 0; i < 384; i++) sc += cabs2(buf[(bin[i] + s + 1024) & 1023]);
    if (sc > bestSc) { bestSc = sc; bs = s; }
  }
  eps += 2 * PI * bs / 1024.0;
  float v[384][2];
  for (int i = 0; i < 384; i++) { cf c = buf[(bin[i] + bs + 1024) & 1023] * (float)rnd_[i]; v[i][0] = c.real(); v[i][1] = c.imag(); }
  uint8_t m[384];
  m[0] = 0;
  for (int i = 1; i < 384; i++) {
    float d = v[i][0] * v[i - 1][0] + v[i][1] * v[i - 1][1];
    m[i] = d < 0 ? 1 : 0;
  }
  int bsc = -1, b1 = 0, b2 = 0;
  uint8_t ex[384];
  for (int s1 = 0; s1 < 8; s1++) for (int s2 = 0; s2 < 16; s2++) {
    expectedBits(s1, s2, ex);
    int sc = 0;
    for (int i = 1; i < 384; i++) sc += (m[i] == ex[i]);
    if (sc > bsc) { bsc = sc; b1 = s1; b2 = s2; }
  }
  r.idScore = bsc / 383.f;
  if (r.idScore < 0.80f) return r;
  r.s1 = b1; r.s2 = b2; r.cfo = eps; r.start = pos; r.ok = true;
  return r;
}

}  // namespace dvbofdm
