// Shared pieces of the DVB-T / DVB-T2 receiver: complex type, FFT, small helpers.
#pragma once
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>

namespace dvbofdm {

typedef std::complex<float> cf;
static const double PI = 3.14159265358979323846;

// In-place FFT (forward: exp(-j...)): radix-4 Stockham autosort on split re / im arrays (the inner loops run over contiguous memory
// and vectorise), one radix-2 pass first when log2(n) is odd. Sizes are powers of two, up to 2^16.
struct Fft {
  int n = 0, lg = 0;
  struct Stage { int n, s, m; std::vector<float> w; };   // w: w1r w1i w2r w2i w3r w3i, m entries each
  std::vector<Stage> st;
  std::vector<float> t2r, t2i;                           // radix-2 pass twiddles
  mutable std::vector<float> ar, ai, br, bi;
  explicit Fft(int size = 0) { if (size) init(size); }
  void init(int size) {
    n = size; lg = 0; while ((1 << lg) < n) ++lg;
    st.clear(); ar.assign(n, 0.f); ai.assign(n, 0.f); br.assign(n, 0.f); bi.assign(n, 0.f);
    int len = n, s = 1;
    if (lg & 1) {
      int m = len / 2; t2r.resize(m); t2i.resize(m);
      for (int p = 0; p < m; p++) { t2r[p] = (float)cos(-2 * PI * p / len); t2i[p] = (float)sin(-2 * PI * p / len); }
      len = m; s = 2;
    }
    while (len > 1) {
      Stage g; g.n = len; g.s = s; g.m = len / 4; g.w.resize((size_t)g.m * 6);
      for (int p = 0; p < g.m; p++) for (int k = 1; k <= 3; k++) {
        double a = -2 * PI * p * k / len;
        g.w[(size_t)(2 * (k - 1)) * g.m + p] = (float)cos(a); g.w[(size_t)(2 * (k - 1) + 1) * g.m + p] = (float)sin(a);
      }
      st.push_back(std::move(g));
      len /= 4; s *= 4;
    }
  }
  void run(cf *x, bool inverse = false) const {
    float *a_r = ar.data(), *a_i = ai.data(), *b_r = br.data(), *b_i = bi.data();
    const float *xf = reinterpret_cast<const float *>(x);
    const int o0 = inverse ? 1 : 0, o1 = inverse ? 0 : 1;      // the inverse transform is the forward one with re / im swapped
    for (int i = 0; i < n; i++) { a_r[i] = xf[2 * i + o0]; a_i[i] = xf[2 * i + o1]; }
    if (lg & 1) {
      int m = n / 2, s = 1;
      for (int p = 0; p < m; p++) {
        float wr = t2r[p], wi = t2i[p];
        float xr = a_r[p], xi = a_i[p], yr = a_r[p + m], yi = a_i[p + m];
        b_r[2 * p] = xr + yr; b_i[2 * p] = xi + yi;
        float dr = xr - yr, di = xi - yi;
        b_r[2 * p + 1] = dr * wr - di * wi; b_i[2 * p + 1] = dr * wi + di * wr;
      }
      (void)s;
      std::swap(a_r, b_r); std::swap(a_i, b_i);
    }
    for (const Stage &g : st) {
      const int m = g.m, s = g.s;
      const float *w = g.w.data();
      for (int p = 0; p < m; p++) {
        const float w1r = w[p], w1i = w[m + p], w2r = w[2 * m + p], w2i = w[3 * m + p], w3r = w[4 * m + p], w3i = w[5 * m + p];
        const float *__restrict r0 = a_r + (size_t)s * p, *__restrict r1 = a_r + (size_t)s * (p + m), *__restrict r2 = a_r + (size_t)s * (p + 2 * m), *__restrict r3 = a_r + (size_t)s * (p + 3 * m);
        const float *__restrict i0 = a_i + (size_t)s * p, *__restrict i1 = a_i + (size_t)s * (p + m), *__restrict i2 = a_i + (size_t)s * (p + 2 * m), *__restrict i3 = a_i + (size_t)s * (p + 3 * m);
        float *__restrict q0r = b_r + (size_t)s * 4 * p, *__restrict q0i = b_i + (size_t)s * 4 * p;
        float *__restrict q1r = q0r + s, *__restrict q1i = q0i + s, *__restrict q2r = q0r + 2 * s, *__restrict q2i = q0i + 2 * s, *__restrict q3r = q0r + 3 * s, *__restrict q3i = q0i + 3 * s;
        for (int q = 0; q < s; q++) {
          float ra = r0[q], ia = i0[q], rb = r1[q], ib = i1[q], rc = r2[q], ic = i2[q], rd = r3[q], id = i3[q];
          float apcr = ra + rc, apci = ia + ic, amcr = ra - rc, amci = ia - ic;
          float bpdr = rb + rd, bpdi = ib + id;
          float jr = -(ib - id), ji = rb - rd;                   // j (b - d)
          q0r[q] = apcr + bpdr; q0i[q] = apci + bpdi;
          float t1r = amcr - jr, t1i = amci - ji;
          q1r[q] = t1r * w1r - t1i * w1i; q1i[q] = t1r * w1i + t1i * w1r;
          float t2rr = apcr - bpdr, t2ii = apci - bpdi;
          q2r[q] = t2rr * w2r - t2ii * w2i; q2i[q] = t2rr * w2i + t2ii * w2r;
          float t3r = amcr + jr, t3i = amci + ji;
          q3r[q] = t3r * w3r - t3i * w3i; q3i[q] = t3r * w3i + t3i * w3r;
        }
      }
      std::swap(a_r, b_r); std::swap(a_i, b_i);
    }
    float *xo = reinterpret_cast<float *>(x);
    for (int i = 0; i < n; i++) { xo[2 * i + o0] = a_r[i]; xo[2 * i + o1] = a_i[i]; }
  }
};

// complex division without the library's NaN handling
inline cf cdiv(cf a, cf b) {
  float d = 1.f / (b.real() * b.real() + b.imag() * b.imag());
  return cf((a.real() * b.real() + a.imag() * b.imag()) * d, (a.imag() * b.real() - a.real() * b.imag()) * d);
}

inline float cabs2(const cf &z) { return z.real() * z.real() + z.imag() * z.imag(); }

}  // namespace dvbofdm
