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
  float snrEst = 0, delay = 0;
};

class T2Demod {
 public:
  // x: samples, p2start: absolute index of the first P2 symbol, eps: CFO rad/sample (applied before the FFT),
  // spacing: samples per symbol (fractional allowed), back: samples the window starts before the useful part
  // Returns false when samples are missing.
  static bool run(const std::vector<cf> &buf, int64_t base, const T2Setup &S, int64_t p2start, double eps, double spacing, int back,
                  T2FrameCells &out, bool p2only = false) {
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
      for (int i = 0; i < N; i++) {
        double a = -eps * (double)(s0 + i);
        tmp[i] = buf[s0 + i - base] * cf((float)cos(a), (float)sin(a));
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
          cf h = Y[l][n] / p;
          if (prev >= 0 && n - prev == Dp) acc += std::complex<double>(h * std::conj(hp));
          prev = n; hp = h;
        }
      }
      double d = std::abs(acc) > 0 ? -std::arg(acc) * N / (2 * PI * Dp) : 0.0;
      out.delay = (float)d;
      for (int l = 0; l < nSym; l++) for (int n = 0; n < C; n++) {
        double a = 2 * PI * n * d / N;
        Y[l][n] *= cf((float)cos(a), (float)sin(a));
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
        acc += std::complex<double>(Y[l][n] / p1 * std::conj(Y[l - 1][n] / p0));
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
    // channel estimate
    std::vector<std::vector<cf>> H(nSym, std::vector<cf>(C));
    // P2: frequency interpolation of dense pilots
    for (int l = 0; l < st.N_P2 && l < nSym; l++) {
      std::vector<int> pn; std::vector<cf> pv;
      for (int n = 0; n < C; n++) { cf p; if (pilotVal(l, n, p)) { pn.push_back(n); pv.push_back(Y[l][n] / p); } }
      interpFreq(pn, pv, H[l], C);
    }
    if (!p2only) {
      // data symbols: time interpolation per pilot carrier, then frequency interpolation
      std::vector<std::vector<int>> plist(C);   // symbols with a pilot at carrier n
      std::vector<std::vector<cf>> pval(C);
      for (int l = st.N_P2; l < nSym; l++) for (int n = 0; n < C; n++) {
        cf p; if (pilotVal(l, n, p)) { plist[n].push_back(l); pval[n].push_back(Y[l][n] / p); }
      }
      // include the last P2 symbol as an anchor (its channel is known everywhere)
      std::vector<int> Q;
      for (int n = 0; n < C; n++) if (!plist[n].empty()) Q.push_back(n);
      std::vector<std::vector<cf>> Ht(nSym - st.N_P2, std::vector<cf>(Q.size()));
      for (size_t qi = 0; qi < Q.size(); qi++) {
        int n = Q[qi];
        const std::vector<int> &pl = plist[n]; const std::vector<cf> &pv = pval[n];
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
      std::vector<cf> pvq(Q.size());
      for (int l = st.N_P2; l < nSym; l++) {
        interpFreq(Q, Ht[l - st.N_P2], H[l], C);
      }
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
        c.push_back(h2 > 1e-12f ? Y[l][n] / H[l][n] : cf(0, 0)); w.push_back(h2);
      }
      if ((int)c.size() != cnt) { out.cell[l].clear(); continue; }
      out.cell[l].assign(cnt, cf()); out.wgt[l].assign(cnt, 0.f);
      for (int j = 0; j < cnt; j++) { out.cell[l][Hm[j]] = c[j]; out.wgt[l][Hm[j]] = w[j]; }
    }
    return true;
  }

 private:
  // linear interpolation of pilot channel estimates (carrier positions pn) to all carriers 0..C-1
  static void interpFreq(const std::vector<int> &pn, const std::vector<cf> &pv, std::vector<cf> &H, int C) {
    if (pn.empty()) { std::fill(H.begin(), H.end(), cf(1, 0)); return; }
    size_t k = 0;
    for (int n = 0; n < C; n++) {
      while (k < pn.size() && pn[k] <= n) k++;
      if (k == 0) H[n] = pv[0];
      else if (k == pn.size()) H[n] = pv.back();
      else { float a = (float)(n - pn[k - 1]) / (pn[k] - pn[k - 1]); H[n] = pv[k - 1] * (1 - a) + pv[k] * a; }
    }
  }
};

}  // namespace dvbofdm
