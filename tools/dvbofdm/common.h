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

// In-place radix-2 FFT (forward: exp(-j...)), sizes up to 2^16, twiddles cached per size.
struct Fft {
  int n = 0, lg = 0;
  std::vector<cf> tw;
  std::vector<uint16_t> rev;
  explicit Fft(int size = 0) { if (size) init(size); }
  void init(int size) {
    n = size; lg = 0; while ((1 << lg) < n) ++lg;
    tw.resize(n / 2);
    for (int i = 0; i < n / 2; ++i) tw[i] = cf((float)cos(-2 * PI * i / n), (float)sin(-2 * PI * i / n));
    rev.resize(n);
    for (int i = 0; i < n; ++i) { int r = 0; for (int b = 0; b < lg; ++b) if (i & (1 << b)) r |= 1 << (lg - 1 - b); rev[i] = (uint16_t)r; }
  }
  void run(cf *x, bool inverse = false) const {
    for (int i = 0; i < n; ++i) { int j = rev[i]; if (j > i) std::swap(x[i], x[j]); }
    for (int len = 2; len <= n; len <<= 1) {
      int half = len >> 1, step = n / len;
      for (int i = 0; i < n; i += len) {
        for (int k = 0; k < half; ++k) {
          cf w = tw[k * step]; if (inverse) w = std::conj(w);
          cf a = x[i + k], b = x[i + k + half] * w;
          x[i + k] = a + b; x[i + k + half] = a - b;
        }
      }
    }
  }
};

inline float cabs2(const cf &z) { return z.real() * z.real() + z.imag() * z.imag(); }

}  // namespace dvbofdm
