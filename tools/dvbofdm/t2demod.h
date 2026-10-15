// DVB-T2 frame demodulation: symbol FFTs, pilot based channel estimation, equalisation and frequency de-interleaving.
#pragma once
#include "common.h"
#include "t2struct_gen.h"
#include "t2freq_gen.h"
#include "t2l1.h"
#include <memory>
#include <cstdio>
#include <cstdlib>

namespace dvbofdm {

static const int T2_FFT_OF_S2[8] = {2048, 8192, 4096, 1024, 16384, 32768, 8192, 32768};
static const gr::dtv::dvbt2_fftsize_t T2_ENUM_OF_S2[8] = {gr::dtv::FFTSIZE_2K, gr::dtv::FFTSIZE_8K, gr::dtv::FFTSIZE_4K, gr::dtv::FFTSIZE_1K,
    gr::dtv::FFTSIZE_16K, gr::dtv::FFTSIZE_32K, gr::dtv::FFTSIZE_8K_T2GI, gr::dtv::FFTSIZE_32K_T2GI};
static const double T2_GI_FRAC[7] = {1 / 32., 1 / 16., 1 / 8., 1 / 4., 1 / 128., 19 / 128., 19 / 256.};

// Everything derived from the P1/L1-pre of a frame
struct T2Setup {
  int fftIdx = 0, N = 0, G = 0, giIdx = 0, ext = 0, miso = 0, pp = 0, papr = 0, ndata = 0, ver = 0;
  std::unique_ptr<gr::dtv::T2Struct> st;
  std::unique_ptr<gr::dtv::T2FreqIl> fi;
  Fft fft;
  int left = 0;
  int numSymbols() const { return st->num_symbols; }
  void build(int fftIdx_, int giIdx_, int ext_, int miso_, int pp_, int papr_, int ndata_, int ver_) {
    using namespace gr::dtv;
    fftIdx = fftIdx_; giIdx = giIdx_; ext = ext_; miso = miso_; pp = pp_; papr = papr_; ndata = ndata_; ver = ver_;
    N = T2_FFT_OF_S2[fftIdx]; G = (int)(N * T2_GI_FRAC[giIdx] + 0.5);
    dvbt2_extended_carrier_t cm = ext ? CARRIERS_EXTENDED : CARRIERS_NORMAL;
    dvbt2_preamble_t pre = miso ? PREAMBLE_T2_MISO : PREAMBLE_T2_SISO;
    st.reset(new T2Struct(cm, T2_ENUM_OF_S2[fftIdx], (dvbt2_pilotpattern_t)pp, (dvb_guardinterval_t)giIdx, ndata, (dvbt2_papr_t)papr,
                          (dvbt2_version_t)(ver > 2 ? 0 : ver), pre, MISO_TX1, EQUALIZATION_OFF, BANDWIDTH_8_0_MHZ, N));
    fi.reset(new T2FreqIl(cm, T2_ENUM_OF_S2[fftIdx], (dvbt2_pilotpattern_t)pp, (dvb_guardinterval_t)giIdx, ndata, (dvbt2_papr_t)papr,
                          (dvbt2_version_t)(ver > 2 ? 0 : ver), pre));
    fft.init(N);
    left = (N - st->C_PS) / 2 + 1;
  }
};

// Equalised cells of a frame
struct T2FrameCells {
  int nP2 = 0, cP2 = 0, cData = 0, nFc = 0, cFc = 0, nData = 0;
  // per symbol (P2 then data), data cells in original (de-interleaved) order
  std::vector<std::vector<cf>> cell;
  std::vector<std::vector<float>> wgt;
  float snrEst = 0, delay = 0, slope = 0; int cirLo = 0, cirHi = 0;   // slope: window drift in samples per symbol (sampling clock error)
};

class T2Demod {
 public:
  // x: samples, p2start: absolute index of the first P2 symbol, eps: CFO rad/sample (applied before the FFT),
  // spacing: samples per symbol (fractional allowed), back: samples the window starts before the useful part
  // Returns false when samples are missing.
  static bool run(const std::vector<cf> &buf, int64_t base, const T2Setup &S, int64_t p2start, double eps, double spacing, int back,
                  T2FrameCells &out, bool p2only = false, int timeSmooth = 2) {
    using namespace gr::dtv;
    const T2Struct &st = *S.st;
    const int N = S.N, G = S.G, nSym = p2only ? st.N_P2 : st.num_symbols, C = st.C_PS;
    int L_FC = st.N_FC != 0 ? 1 : 0;
    int64_t last = p2start + (int64_t)((nSym) * spacing) + 8;
    if (p2start - base < 0 || last - base > (int64_t)buf.size()) return false;
    // FFT of every symbol
    std::vector<std::vector<cf>> Y(nSym, std::vector<cf>(C));
    std::vector<cf> tmp(N);
    for (int l = 0; l < nSym; l++) {
      int64_t s0 = p2start + (int64_t)llround(l * spacing) + G - back;
      {
        double a0 = std::fmod(-eps * (double)s0, 2 * PI);
        cf ph((float)cos(a0), (float)sin(a0)), rot((float)cos(-eps), (float)sin(-eps));
        const cf *src = &buf[s0 - base];
        for (int i = 0; i < N; i++) {
          tmp[i] = src[i] * ph; ph *= rot;
          if ((i & 255) == 255) ph *= 1.f / std::sqrt(cabs2(ph));
        }
      }
      S.fft.run(tmp.data());
      for (int n = 0; n < C; n++) Y[l][n] = tmp[(S.left + n + N / 2) % N];
    }
    // pilot value of carrier n in symbol l, 0 when not a pilot
    auto pilotVal = [&](int l, int n, cf &v) -> bool {
      int bit = st.prbs[n + st.K_OFFSET] ^ st.pn_sequence[l];
      int t;
      if (l < st.N_P2) {
        t = st.p2_carrier_map[n];
        if (t == P2PILOT_CARRIER) { v = st.p2_bpsk[bit]; return true; }
        if (t == P2PILOT_CARRIER_INVERTED) { v = st.p2_bpsk_inverted[bit]; return true; }
        return false;
      }
      if (L_FC && l == st.num_symbols - 1) {
        t = st.fc_carrier_map[n];
        if (t == SCATTERED_CARRIER) { v = st.sp_bpsk[bit]; return true; }
        if (t == SCATTERED_CARRIER_INVERTED) { v = st.sp_bpsk_inverted[bit]; return true; }
        return false;
      }
      t = st.data_carrier_map[l][n];
      if (t == SCATTERED_CARRIER) { v = st.sp_bpsk[bit]; return true; }
      if (t == SCATTERED_CARRIER_INVERTED) { v = st.sp_bpsk_inverted[bit]; return true; }
      if (t == CONTINUAL_CARRIER) { v = st.cp_bpsk[bit]; return true; }
      if (t == CONTINUAL_CARRIER_INVERTED) { v = st.cp_bpsk_inverted[bit]; return true; }
      return false;
    };
    auto isCont = [&](int l, int n) {
      if (l < st.N_P2 || (L_FC && l == st.num_symbols - 1)) return false;
      int t = st.data_carrier_map[l][n];
      return t == CONTINUAL_CARRIER || t == CONTINUAL_CARRIER_INVERTED;
    };
    // delay compensation: pilots of the P2 symbols (every 3rd carrier) give the slope of the channel phase, remove it so the
    // interpolation sees a flat channel. The estimate is in samples (window start earlier than the useful part).
    {
      // pilot spacing of the P2 symbols (3 carriers, 6 for 32K): the most frequent distance between neighbouring pilots
      std::vector<int> hist(64, 0);
      { int prev = -1; for (int n = 0; n < C; n++) { cf p; if (!pilotVal(0, n, p)) continue; if (prev >= 0 && n - prev < 64) hist[n - prev]++; prev = n; } }
      int Dp = 3, best = 0; for (int d = 2; d < 64; d++) if (hist[d] > best) { best = hist[d]; Dp = d; }
      std::complex<double> acc = 0;
      for (int l = 0; l < st.N_P2 && l < nSym; l++) {
        int prev = -1; cf hp;
        for (int n = 0; n < C; n++) {
          cf p; if (!pilotVal(l, n, p)) continue;
          cf h = cdiv(Y[l][n], p);
          if (prev >= 0 && n - prev == Dp) acc += std::complex<double>(h * std::conj(hp));
          prev = n; hp = h;
        }
      }
      double d = std::abs(acc) > 0 ? -std::arg(acc) * N / (2 * PI * Dp) : 0.0;
      // impulse response from the regular pilot lattice of the first P2 symbol: the window of length G with the most energy
      {
        std::vector<int> res(Dp, 0);
        for (int n = 0; n < C; n++) { cf p; if (pilotVal(0, n, p)) res[n % Dp]++; }
        int r0 = (int)(std::max_element(res.begin(), res.end()) - res.begin());
        std::vector<cf> F(N, cf(0, 0));
        for (int l = 0; l < st.N_P2 && l < 1; l++) for (int n = 0; n < C; n++) {
          cf p; if (n % Dp != r0 || !pilotVal(l, n, p)) continue;
          F[(S.left + n + N / 2) % N] = cdiv(Y[l][n], p);
        }
        S.fft.run(F.data(), true);
        int T = N / (2 * Dp) - 1;
        std::vector<double> P(2 * T), cum(2 * T + 1, 0.0);
        double pk = 0;
        for (int t = -T; t < T; t++) { P[t + T] = cabs2(F[(t + N) % N]); pk = std::max(pk, P[t + T]); }
        std::vector<double> srt = P; std::nth_element(srt.begin(), srt.begin() + srt.size() / 2, srt.end());
        double thr = std::max(pk * 0.003, 15.0 * srt[srt.size() / 2]);
        for (int i = 0; i < 2 * T; i++) cum[i + 1] = cum[i] + P[i];
        int best = 0; double be = -1;
        for (int i = 0; i + G <= 2 * T; i++) { double e = cum[i + G] - cum[i]; if (e > be) { be = e; best = i; } }
        int lo = -1, hi = -1;
        for (int i = best; i < best + G && i < 2 * T; i++) if (P[i] > thr) { if (lo < 0) lo = i; hi = i; }
        if (lo >= 0 && pk > 0) d = 0.5 * ((lo - T) + (hi - T));
        out.cirLo = lo >= 0 ? lo - T : 0; out.cirHi = hi >= 0 ? hi - T : 0;
      }
      out.delay = (float)d;
      {
        cf rot((float)cos(2 * PI * d / N), (float)sin(2 * PI * d / N));
        for (int l = 0; l < nSym; l++) {
          cf ph(1, 0);
          for (int n = 0; n < C; n++) { Y[l][n] *= ph; ph *= rot; if ((n & 255) == 255) ph *= 1.f / std::sqrt(cabs2(ph)); }
        }
      }
    }
    // window drift from the sampling clock: the ratio of the pilots of the same carriers in symbols l and l-Dy removes the channel,
    // what remains is the phase ramp of the delay change; a line is fitted through the accumulated drift and removed
    {
      const int Dy = std::max(st.dy, 1), Dsp = st.dx * Dy;
      std::vector<double> Dd(nSym, 0.0); std::vector<char> okd(nSym, 0);
      auto scat = [&](int l, int n) { int t = st.data_carrier_map[l][n]; return t == SCATTERED_CARRIER || t == SCATTERED_CARRIER_INVERTED; };
      for (int l = st.N_P2 + Dy; l < nSym; l++) {
        if (L_FC && l >= st.num_symbols - 1) break;
        std::complex<double> acc = 0; int prevn = -1; cf prevR;
        for (int n = 0; n < C; n++) {
          if (!scat(l, n) || !scat(l - Dy, n)) continue;
          cf p1, p0; pilotVal(l, n, p1); pilotVal(l - Dy, n, p0);
          cf R = cdiv(Y[l][n], p1) * std::conj(cdiv(Y[l - Dy][n], p0));
          if (prevn >= 0 && n - prevn == Dsp) acc += std::complex<double>(R * std::conj(prevR));
          prevn = n; prevR = R;
        }
        if (std::abs(acc) <= 0) continue;
        double step = -std::arg(acc) * N / (2 * PI * Dsp);
        Dd[l] = (l - Dy >= st.N_P2 + Dy && okd[l - Dy] ? Dd[l - Dy] : 0.0) + step; okd[l] = 1;
      }
      double sx = 0, sy = 0, sxx = 0, sxy = 0; int cnt = 0;
      for (int l = st.N_P2; l < nSym; l++) if (okd[l]) { sx += l; sy += Dd[l]; sxx += (double)l * l; sxy += l * Dd[l]; cnt++; }
      double den = cnt * sxx - sx * sx, slope = (cnt > 8 && den > 0) ? (cnt * sxy - sx * sy) / den : 0.0;
      out.slope = (float)slope;
      if (std::fabs(slope) * (nSym - st.N_P2) > 1.0) {      // more than a sample over the frame: compensate
        for (int l = st.N_P2; l < nSym; l++) {
          double d = slope * (l - st.N_P2);
          cf rot((float)cos(2 * PI * d / N), (float)sin(2 * PI * d / N)), ph(1, 0);
          for (int n = 0; n < C; n++) { Y[l][n] *= ph; ph *= rot; if ((n & 255) == 255) ph *= 1.f / std::sqrt(cabs2(ph)); }
        }
      }
    }
    // common phase error between consecutive data symbols from the continual pilots
    std::vector<double> phi(nSym, 0.0);
    for (int l = st.N_P2 + 1; l < nSym; l++) {
      if (L_FC && l == st.num_symbols - 1) { phi[l] = phi[l - 1]; continue; }
      std::complex<double> acc = 0;
      for (int n = 0; n < C; n++) {
        if (!isCont(l, n) || !isCont(l - 1, n)) continue;
        cf p1, p0; pilotVal(l, n, p1); pilotVal(l - 1, n, p0);
        acc += std::complex<double>(cdiv(Y[l][n], p1) * std::conj(cdiv(Y[l - 1][n], p0)));
      }
      phi[l] = phi[l - 1] + (std::abs(acc) > 0 ? std::arg(acc) : 0.0);
    }
    for (int l = st.N_P2; l < nSym; l++) {
      cf rot((float)cos(-phi[l]), (float)sin(-phi[l]));
      for (int n = 0; n < C; n++) Y[l][n] *= rot;
    }
    if (getenv("T2DBG")) {
      for (int l : {st.N_P2, st.N_P2 + 1, st.N_P2 + 5}) {
        if (l >= nSym) continue;
        int shown = 0;
        for (int n = 0; n < C && shown < 6; n++) { cf p; if (pilotVal(l, n, p)) { cf h = Y[l][n] / p; fprintf(stderr, "sym %d carrier %d type %d |h| %.3f arg %.3f\n", l, n, st.data_carrier_map[l][n], std::abs(h), std::arg(h)); shown++; } }
      }
      fprintf(stderr, "phi: "); for (int l = st.N_P2; l < std::min(nSym, st.N_P2 + 8); l++) fprintf(stderr, "%.3f ", phi[l]); fprintf(stderr, "\n");
    }
    if (getenv("T2DBG3")) {
      int shown = 0;
      for (int n = 6000; n < C && shown < 12; n++) { cf p; if (pilotVal(0, n, p)) { cf h = Y[0][n] / p; fprintf(stderr, "P2 pilot n %d |h| %.3f arg %.3f\n", n, std::abs(h), std::arg(h)); shown++; } }
    }
    // channel estimate
    Kernel K; K.init(N, G, std::max(st.dx, 3));
    std::vector<std::vector<cf>> H(nSym, std::vector<cf>(C));
    // P2: frequency interpolation of dense pilots
    for (int l = 0; l < st.N_P2 && l < nSym; l++) {
      std::vector<int> pn; std::vector<cf> pv;
      for (int n = 0; n < C; n++) { cf p; if (pilotVal(l, n, p)) { pn.push_back(n); pv.push_back(cdiv(Y[l][n], p)); } }
      interpFir(pn, pv, H[l], C, K);
      if (getenv("T2DBG3")) { double e = 0; for (size_t i = 0; i < pn.size(); i++) e += cabs2(H[l][pn[i]] - pv[i]); fprintf(stderr, "P2 sym %d: rms(H_est - pilot ratio) %.4f over %zu pilots, kernel R %d\n", l, sqrt(e / pn.size()), pn.size(), K.R); }
    }
    if (!p2only) {
      // data symbols: time interpolation per pilot carrier, then frequency interpolation
      std::vector<std::vector<int>> plist(C);   // symbols with a pilot at carrier n
      std::vector<std::vector<cf>> pval(C);
      for (int l = st.N_P2; l < nSym; l++) for (int n = 0; n < C; n++) {
        cf p; if (pilotVal(l, n, p)) { plist[n].push_back(l); pval[n].push_back(cdiv(Y[l][n], p)); }
      }
      // include the last P2 symbol as an anchor (its channel is known everywhere)
      std::vector<int> Q;
      for (int n = 0; n < C; n++) if (!plist[n].empty()) Q.push_back(n);
      std::vector<std::vector<cf>> Ht(nSym - st.N_P2, std::vector<cf>(Q.size()));
      for (size_t qi = 0; qi < Q.size(); qi++) {
        int n = Q[qi];
        const std::vector<int> &pl = plist[n];
        // smooth the pilot estimates of this carrier along time (static or slowly varying channel): triangular kernel
        std::vector<cf> pv(pval[n].size());
        {
          const int J = timeSmooth;
          const std::vector<cf> &raw = pval[n];
          for (int i = 0; i < (int)raw.size(); i++) {
            cf acc(0, 0); float ws = 0;
            for (int j = -J; j <= J; j++) { int k2 = i + j; if (k2 < 0 || k2 >= (int)raw.size()) continue; float w = (float)(J + 1 - abs(j)); acc += raw[k2] * w; ws += w; }
            pv[i] = acc * (1.f / ws);
          }
        }
        size_t k = 0;
        for (int l = st.N_P2; l < nSym; l++) {
          while (k < pl.size() && pl[k] < l) k++;
          cf v;
          if (k < pl.size() && pl[k] == l) v = pv[k];
          else if (k == 0) v = pv[0];
          else if (k == pl.size()) v = pv.back();
          else { float a = (float)(l - pl[k - 1]) / (pl[k] - pl[k - 1]); v = pv[k - 1] * (1 - a) + pv[k] * a; }
          Ht[l - st.N_P2][qi] = v;
        }
      }
      Plan plQ; plan(Q, C, K, plQ);
      for (int l = st.N_P2; l < nSym; l++) apply(plQ, Ht[l - st.N_P2], H[l], C);
    }
    // equalise, extract data cells, de-interleave
    out.nP2 = st.N_P2; out.cP2 = st.C_P2; out.cData = st.C_DATA; out.nFc = st.N_FC; out.cFc = st.C_FC; out.nData = st.num_symbols - st.N_P2;
    out.cell.assign(nSym, std::vector<cf>()); out.wgt.assign(nSym, std::vector<float>());
    double errAcc = 0, pwrAcc = 0;
    for (int l = 0; l < nSym; l++) {
      bool p2 = l < st.N_P2, fc = L_FC && l == st.num_symbols - 1;
      int cnt = p2 ? st.C_P2 : fc ? st.N_FC : st.C_DATA;
      const int *Hm = (l % 2) == 0 ? (p2 ? S.fi->HevenP2 : fc ? S.fi->HevenFC : S.fi->Heven) : (p2 ? S.fi->HoddP2 : fc ? S.fi->HoddFC : S.fi->Hodd);
      std::vector<cf> c; std::vector<float> w;
      c.reserve(cnt); w.reserve(cnt);
      for (int n = 0; n < C; n++) {
        int t = p2 ? st.p2_carrier_map[n] : fc ? st.fc_carrier_map[n] : st.data_carrier_map[l][n];
        if (t != DATA_CARRIER) continue;
        float h2 = cabs2(H[l][n]);
        c.push_back(h2 > 1e-12f ? cdiv(Y[l][n], H[l][n]) : cf(0, 0)); w.push_back(h2);
      }
      if ((int)c.size() != cnt) { out.cell[l].clear(); continue; }
      out.cell[l].assign(cnt, cf()); out.wgt[l].assign(cnt, 0.f);
      for (int j = 0; j < cnt; j++) { out.cell[l][Hm[j]] = c[j]; out.wgt[l][Hm[j]] = w[j]; }
    }
    return true;
  }

 private:
  // Channel interpolation across carriers: windowed-sinc low-pass whose bandwidth is the guard interval (the channel impulse
  // response lies within it), on the possibly irregular set of pilot carriers pn; weights are normalised.
  struct Kernel {
    int R = 0; std::vector<float> g;
    void init(int N, int G, int Dx) {
      R = std::max(6 * Dx, 12);
      double tc = 0.6 * G, a = 2 * tc / N;
      g.assign(2 * R + 1, 0.f);
      for (int d = -R; d <= R; d++) {
        double x = a * d, sinc = d == 0 ? 1.0 : sin(PI * x) / (PI * x);
        g[d + R] = (float)(a * sinc * (0.5 + 0.5 * cos(PI * d / (R + 1))));
      }
    }
  };
  // The weights depend only on the pilot carrier set, so they are computed once per set and applied to every symbol.
  struct Plan {
    std::vector<int> first, cnt, nearest; std::vector<size_t> off; std::vector<float> w;
  };
  static void plan(const std::vector<int> &pn, int C, const Kernel &K, Plan &P) {
    P.first.assign(C, 0); P.cnt.assign(C, 0); P.nearest.assign(C, 0); P.off.assign(C, 0); P.w.clear();
    if (pn.empty()) return;
    size_t lo = 0;
    for (int n = 0; n < C; n++) {
      while (lo < pn.size() && pn[lo] < n - K.R) lo++;
      float ws = 0; size_t i = lo;
      for (; i < pn.size() && pn[i] <= n + K.R; i++) ws += K.g[pn[i] - n + K.R];
      P.first[n] = (int)lo; P.off[n] = P.w.size();
      if (ws > 1e-6f) {
        P.cnt[n] = (int)(i - lo);
        for (size_t j = lo; j < i; j++) P.w.push_back(K.g[pn[j] - n + K.R] / ws);
      } else {                                        // outside the support of every node: nearest pilot
        size_t j = std::lower_bound(pn.begin(), pn.end(), n) - pn.begin();
        if (j >= pn.size()) j = pn.size() - 1;
        if (j > 0 && n - pn[j - 1] < pn[j] - n) j--;
        P.nearest[n] = (int)j; P.cnt[n] = 0;
      }
    }
  }
  static void apply(const Plan &P, const std::vector<cf> &pv, std::vector<cf> &H, int C) {
    if (P.first.empty()) { std::fill(H.begin(), H.end(), cf(1, 0)); return; }
    const float *v = reinterpret_cast<const float *>(pv.data());
    for (int n = 0; n < C; n++) {
      int c = P.cnt[n];
      if (!c) { H[n] = pv[P.nearest[n]]; continue; }
      const float *w = &P.w[P.off[n]], *x = v + 2 * (size_t)P.first[n];
      float re = 0, im = 0;
      for (int i = 0; i < c; i++) { re += w[i] * x[2 * i]; im += w[i] * x[2 * i + 1]; }
      H[n] = cf(re, im);
    }
  }
  static void interpFir(const std::vector<int> &pn, const std::vector<cf> &pv, std::vector<cf> &H, int C, const Kernel &K) {
    Plan P; plan(pn, C, K, P); apply(P, pv, H, C);
  }
};

}  // namespace dvbofdm
