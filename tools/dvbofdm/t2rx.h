// DVB-T2 receiver: IQ at the nominal sample rate -> transport stream of one PLP.
#pragma once
#include "common.h"
#include "t2p1.h"
#include "t2demod.h"
#include "t2plps.h"
#include <string>
#include <map>
#include <memory>

namespace dvbofdm {

struct T2Status {
  bool lock = false;           // P1 found, L1 CRC ok in the last frame
  bool fecOk = false;          // FEC blocks of the selected PLP decoded
  int fftSize = 0, giIdx = -1, mod = -1, cod = -1, plpId = -1, pp = 0, ext = 0, rot = 0, fecLong = 0;
  double cfoHz = 0, snrDb = 0, delay = 0, sfoPpm = 0;
  uint64_t frames = 0, framesOk = 0, blocks = 0, blocksOk = 0, blocksFix = 0, ts = 0, packets = 0;
  int numPlp = 0, frameIdx = 0; bool tiSwap = false;
  double preSnr = -99; int preGi = -1, preExt = 0, prePapr = 0;
  uint64_t p1ok = 0, p1bad = 0, preBad = 0; double metric = 0, idScore = 0; int s1 = -1, s2 = -1;   // search diagnostics
  std::vector<PlpCfg> plps;
  std::string text;
};

class T2Receiver {
 public:
  struct Config { double bwMhz = 8; int plp = -1; bool mergeCommon = true; };
  Config cfg;
  T2Status st;
  std::vector<uint8_t> ts;   // output transport stream, drained by the caller

  double fs0() const {
    static const double bw[6] = {1.7, 5, 6, 7, 8, 10};
    double b = cfg.bwMhz;
    if (b < 2) return 131e6 / 71.0;
    if (b == 7) return 8e6;
    return b * 8e6 / 7.0;
  }

  void feed(const cf *x, size_t n) {
    buf_.insert(buf_.end(), x, x + n);
    step();
  }
  // The host dropped samples: what is buffered no longer continues with what comes next
  void gap() {
    base_ += (int64_t)buf_.size(); buf_.clear();
    scanPos_ = base_; expect_ = -1; lastP1_ = -1;
    st.lock = false;
  }

 private:
  std::vector<cf> buf_; int64_t base_ = 0;
  int64_t scanPos_ = 0;                  // absolute index to continue the P1 search from
  P1 p1_; L1Decoder l1_; PlpSet plps_;
  std::map<std::string, std::unique_ptr<T2Setup>> cache_;
  const T2Setup *Sp_ = nullptr; bool haveS_ = false;
  double trackEps_ = 0; bool haveEps_ = false;   // carrier offset of the last decoded frame, rad/sample
  const T2Setup &getSetup(int fftIdx, int gi, int ext, int miso, int pp, int papr, int ndata, int ver) {
    char k[96]; snprintf(k, sizeof k, "%d.%d.%d.%d.%d.%d.%d.%d", fftIdx, gi, ext, miso, pp, papr, ndata, ver);
    auto it = cache_.find(k);
    if (it == cache_.end()) {
      if (cache_.size() > 24) cache_.clear();
      std::unique_ptr<T2Setup> s(new T2Setup()); s->build(fftIdx, gi, ext, miso, pp, papr, ndata, ver);
      it = cache_.emplace(k, std::move(s)).first;
    }
    return *it->second;
  }
  double eps_ = 0, period_ = 0, n0_ = 1.0;          // CFO rad/sample; measured frame period / nominal
  int64_t lastP1_ = -1; int64_t lastLen_ = 0; unsigned giRound_ = 0;
  int back_ = 0;
  int64_t expect_ = -1;                  // expected position of the next P1

  void step() {
    for (;;) {
      int64_t availEnd = base_ + (int64_t)buf_.size();
      int64_t from = scanPos_;
      const int W = 1 << 19;
      if (from < base_) from = base_;
      int64_t winEnd = expect_ >= 0 ? std::min(availEnd, expect_ + 6144 + 2048) : std::min(availEnd, from + W);
      if (expect_ >= 0) from = std::max(from, expect_ - 6144);
      if (winEnd - from < 4096) { trim(); return; }
      float met = 0;
      int64_t rel = p1_.scan(&buf_[from - base_], (int)(winEnd - from), 0.3f, &met);
      if (rel < 0) {
        if (expect_ >= 0 && availEnd < expect_ + 6144 + 2048) { trim(); return; }   // wait for more data around the expectation
        if (expect_ >= 0) expect_ = -1;                                                    // lost: wide search
        scanPos_ = std::max(from, winEnd - 4096);
        if (winEnd >= availEnd) { trim(); return; }
        continue;
      }
      int64_t pos = from + rel;
      if (pos + 2048 + 64 > availEnd) { scanPos_ = pos; trim(); return; }    // need the whole preamble
      P1Info pi = p1_.identify(&buf_[0], (int)buf_.size(), (int)(pos - base_), met);
      st.metric = met; st.idScore = pi.idScore;
      if (!pi.ok) { st.p1bad++; scanPos_ = pos + 1024; continue; }
      st.p1ok++; st.s1 = pi.s1; st.s2 = pi.s2;
      if (pi.s1 > 4 || pi.s1 == 2) { scanPos_ = pos + 2048; continue; }       // not a T2 preamble (FEF / other)
      int status = frame(pos, pi);
      if (status == 0) { trim(); return; }                                     // wait for more samples
      if (status < 0) { scanPos_ = pos + 4096; expect_ = -1; st.lock = false; continue; }
    }
  }

  void trim() {
    int64_t keep = std::min(scanPos_, expect_ >= 0 ? expect_ - 6144 : scanPos_) - 4096;
    if (keep > base_ + (1 << 20)) {
      size_t drop = (size_t)(keep - base_);
      buf_.erase(buf_.begin(), buf_.begin() + drop);
      base_ += drop;
    }
  }

  // 0 = need more samples, 1 = frame processed, -1 = failure
  int frame(int64_t p1pos, const P1Info &pi) {
    int fftIdx = pi.s2 >> 1;
    bool miso = pi.s1 == 1 || pi.s1 == 4;
    int N = T2_FFT_OF_S2[fftIdx];
    // the preamble estimate is only good to about half a carrier spacing of a big FFT: after a decoded frame the tracked value is the better start
    double eps = haveEps_ ? trackEps_ : pi.cfo;
        int64_t p2 = p1pos + 2048;
    L1Pre pre; bool got = false;
    // L1-pre: reuse the previous setup first, otherwise try the guard interval / extended carrier hypotheses
    int tries = 0;
    st.preSnr = -99;
    // guard interval candidates from the cyclic prefix of the first P2 symbol, best first; only the most likely ones are tried on most preambles
    int giOrd[7]; int giTry = 7;
    {
      const double fr[7] = {1 / 32., 1 / 16., 1 / 8., 1 / 4., 1 / 128., 19 / 128., 19 / 256.};
      int Gm = N / 4;
      if (p2 + N + Gm + 8 - base_ > (int64_t)buf_.size()) return 0;
      std::vector<std::complex<double>> P(Gm + 1, 0); std::vector<double> E(Gm + 1, 0);
      const cf *a = &buf_[p2 - base_];
      for (int k = 0; k < Gm; k++) { P[k + 1] = P[k] + std::complex<double>(a[k]) * std::conj(std::complex<double>(a[k + N])); E[k + 1] = E[k] + 0.5 * (cabs2(a[k]) + cabs2(a[k + N])); }
      double rho[7], q[7], en[7], rmax = 0;
      for (int g = 0; g < 7; g++) { int G = (int)(N * fr[g] + 0.5); q[g] = std::abs(P[G]); en[g] = E[G]; rho[g] = en[g] > 0 ? q[g] / en[g] : 0; rmax = std::max(rmax, rho[g]); }
      double lam[7];
      for (int g = 0; g < 7; g++) { giOrd[g] = g; lam[g] = q[g] - 0.5 * rmax * en[g]; }
      std::sort(giOrd, giOrd + 7, [&](int x, int y) { return lam[x] > lam[y]; });
      giTry = (giRound_++ % 4 == 0) ? 7 : 2;
    }
    for (int pass = 0; pass < 2 && !got; pass++) {
      for (int gk = 0; gk < 7 && !got; gk++) for (int ext = 0; ext < 2 && !got; ext++) for (int tr = 0; tr < 2 && !got; tr++) {
        int gi = giOrd[gk];
        bool prev = haveS_ && Sp_->fftIdx == fftIdx && gi == Sp_->giIdx && ext == Sp_->ext && tr == ((Sp_->papr >> 1) & 1);
        if (pass == 0) { if (!prev) continue; } else if (prev || gk >= giTry) continue;
        // tone reservation takes carriers away from P2 too, so the L1 cells sit elsewhere: both layouts are tried
        const T2Setup &s0 = getSetup(fftIdx, gi, ext, miso, 1, tr ? 2 : 0, 1, 0);
        int64_t need = p2 + (int64_t)s0.st->N_P2 * (s0.N + s0.G) + 16;
        if (need - base_ > (int64_t)buf_.size()) return 0;
        // the CFO of the preamble is coarse: with a big FFT a tenth of a carrier spacing already limits the SNR to about 10 dB, so it is refined on the cyclic prefix of the P2 symbols;
        // that fixes only the fraction of a carrier spacing, the whole number (preamble error up to a spacing at 32K) is found by trying the neighbours
        const double epsR = refineCfo(p2, s0, s0.N + s0.G, eps, s0.st->N_P2);
        static const int alias[3] = {0, -1, 1};
        for (int al = 0; al < 3 && !got; al++) {
          T2FrameCells fc;
          double epsH = epsR + alias[al] * 2 * PI / s0.N;
          if (!T2Demod::run(buf_, base_, s0, p2, epsH, s0.N + s0.G, s0.G / 2, fc, true)) return 0;
          int NP = s0.st->N_P2;
          std::vector<cf> c(1840); std::vector<float> w(1840);
          for (int s = 0; s < NP; s++) for (int j = 0; j < 1840 / NP; j++) { c[s + j * NP] = fc.cell[s][j]; w[s + j * NP] = fc.wgt[s][j]; }
          {   // how well do these cells look like BPSK: tells a wrong layout from a bad channel
            double e = 0, mw = 0;
            for (int i = 0; i < 1840; i++) { cf d = c[i] - cf(c[i].real() >= 0 ? 1.f : -1.f, 0); e += w[i] * cabs2(d); mw += w[i]; }
            double sn = 10 * log10(std::max(mw / 1840.0, 1e-12) / std::max(e / 1840.0, 1e-12));
              if (sn > st.preSnr) { st.preSnr = sn; st.preGi = gi; st.preExt = ext; st.prePapr = tr; }
          }
          tries++;
            if (l1_.decodePre(c.data(), w.data(), pre)) {
            got = true; eps = epsH; trackEps_ = epsH; haveEps_ = true;
            // noise power before equalisation: |z - s|^2 is sigma^2/|H|^2, times the weight |H|^2
            double e = 0; for (int i = 0; i < 1840; i++) { cf d = c[i] - cf(c[i].real() >= 0 ? 1.f : -1.f, 0); e += w[i] * cabs2(d); }
            double mw = 0; for (int i = 0; i < 1840; i++) mw += w[i];
            n0_ = std::max(1e-12, e / 1840.0);
            st.snrDb = 10 * log10(std::max(mw / 1840.0, 1e-12) / n0_);
          }
        }
      }
    }
    if (!got) { st.preBad++; haveEps_ = false; return -1; }
    Sp_ = &getSetup(fftIdx, pre.gi, pre.bwtExt, miso, pre.pp, pre.papr, pre.nData, pre.ver);
    const T2Setup &S_ = *Sp_;
    haveS_ = true;
    const int symLen = S_.N + S_.G;
    int64_t frameLen = 2048 + (int64_t)S_.numSymbols() * symLen;
    // timing from the previous frame: the window start moves with the measured delay
    if (p2 + (int64_t)S_.numSymbols() * symLen + 5200 - base_ > (int64_t)buf_.size()) return 0;   // + room for resampling
    st.frames++;
    back_ = S_.G / 2;
    double spacing = symLen * (period_ > 0 ? period_ : 1.0);
    eps = refineCfo(p2, S_, spacing, eps);
    T2FrameCells fc;
    T2Demod::run(buf_, base_, S_, p2, eps, spacing, back_, fc);
    // second pass with the timing measured on the pilots (window should start 'back' samples before the useful part)
    double corr = fc.delay - back_;
    if (fabs(corr) > 2) {
      p2 += (int64_t)llround(corr);
      if (p2 + (int64_t)S_.numSymbols() * symLen + 16 - base_ > (int64_t)buf_.size()) { p2 -= (int64_t)llround(corr); }
      else T2Demod::run(buf_, base_, S_, p2, eps, spacing, back_, fc);
    }
    // sampling clock error: the window drifts by rho*(N+G) per symbol; resample the frame and demodulate again
    {
      double rho = fc.slope / (double)symLen;
      if (period_ > 0 && fabs(period_ - 1) > fabs(rho)) rho = period_ - 1;
      if (fabs(rho) > 2e-6 && fabs(rho) < 2e-3) {
        std::vector<cf> seg;
        int64_t segStart = p2 - 32;
        size_t cnt = (size_t)(((double)(S_.numSymbols() * symLen) + 96) * (1 + fabs(rho)) / (1 + rho));
        if (resample(segStart, cnt, 1 + rho, seg)) {
          T2Demod::run(seg, segStart, S_, p2, eps, symLen, back_, fc);
          double corr2 = fc.delay - back_;
          if (fabs(corr2) > 2) { int64_t p2b = p2 + (int64_t)llround(corr2); if (p2b - segStart >= 0 && p2b - segStart + (int64_t)S_.numSymbols() * symLen + 16 < (int64_t)seg.size()) T2Demod::run(seg, segStart, S_, p2b, eps, symLen, back_, fc); }
          st.sfoPpm = rho * 1e6;
        }
      }
    }
    st.delay = fc.delay;
    // L1-post; the noise level comes from the L1-pre cells of this (correct) setup
    int NP = S_.st->N_P2, npc = pre.postSize;
    {
      double e = 0, mw = 0;
      for (int u = 0; u < 1840; u++) { int s = u % NP, j = u / NP; cf z = fc.cell[s][j]; cf d = z - cf(z.real() >= 0 ? 1.f : -1.f, 0); e += fc.wgt[s][j] * cabs2(d); mw += fc.wgt[s][j]; }
      n0_ = std::max(1e-12, e / 1840.0); st.snrDb = 10 * log10(std::max(mw / 1840.0, 1e-12) / n0_);
    }
    std::vector<cf> pc(npc); std::vector<float> pw(npc);
    for (int u = 0; u < npc; u++) { int s = u % NP, j = 1840 / NP + u / NP; pc[u] = fc.cell[s][j]; pw[u] = fc.wgt[s][j]; }
    L1Post post;
    if (!l1_.decodePost(pre, pc.data(), pw.data(), post)) {
      st.lock = false; st.text = "L1-post CRC failed";
      finish(p1pos, frameLen, eps);
      return 1;
    }
    st.lock = true; st.framesOk++;
    st.fftSize = S_.N; st.giIdx = pre.gi; st.pp = pre.pp; st.ext = pre.bwtExt; st.numPlp = post.numPlp;
    // PLP selection: the requested id, otherwise the first data PLP
    st.plps = post.plp; st.frameIdx = post.frameIdx;
    const PlpCfg *sel = nullptr, *common = nullptr;
    if (cfg.plp >= 0) { for (auto &p : post.plp) if (p.id == cfg.plp) sel = &p; }
    else { for (auto &p : post.plp) if (p.type != 0) { sel = &p; break; } if (!sel && !post.plp.empty()) sel = &post.plp[0]; }
    if (sel && cfg.mergeCommon && sel->type != 0) for (auto &p : post.plp) if (p.type == 0 && p.group == sel->group) common = &p;
    if (sel) {
      T2Stream str; buildStream(fc, pre, str);
      PlpStats acc;
      std::string msg;
      plps_.frame(*sel, post, str, acc, msg);
      if (common) plps_.frame(*common, post, str, acc, msg);
      PlpRun &r = plps_.run[sel->id];
      st.plpId = sel->id; st.mod = sel->mod; st.cod = sel->cod; st.rot = sel->rot; st.fecLong = (sel->fec & 3) == 1;
      st.blocks += acc.blocks; st.blocksOk += acc.ok;
      st.fecOk = acc.blocks > 0 && acc.ok == acc.blocks;
      if (common) PlpSet::mergeCommonPackets(r.out, plps_.run[common->id].out);
      st.ts += r.out.size(); ts.insert(ts.end(), r.out.begin(), r.out.end()); r.out.clear();
      if (common) plps_.run[common->id].out.size() > (1u << 22) ? plps_.run[common->id].out.clear() : (void)0;
      st.packets = r.dec.bb.packets; st.tiSwap = r.dec.bigFirst;
      if (!msg.empty()) st.text = msg;
    }
    finish(p1pos, frameLen, eps);
    return 1;
  }

  // Carrier offset from the cyclic prefixes of the whole frame: x[n] conj(x[n+N]) has the phase -eps*N
  double refineCfo(int64_t p2, const T2Setup &S, double spacing, double eps0, int nSym = 0) {
    std::complex<double> acc = 0;
    const int N = S.N, G = S.G;
    if (nSym <= 0) nSym = S.numSymbols();
    for (int l = 0; l < nSym; l++) {
      int64_t s0 = p2 + (int64_t)llround(l * spacing);
      if (s0 - base_ < 0 || s0 + N + G - base_ > (int64_t)buf_.size()) break;
      const cf *a = &buf_[s0 - base_];
      for (int i = G / 8; i < G; i++) acc += std::complex<double>(a[i]) * std::conj(std::complex<double>(a[i + N]));
    }
    if (std::abs(acc) <= 0) return eps0;
    double ph = -std::arg(acc);
    // closest solution to the preamble estimate: eps = (ph + 2 pi k) / N
    double k = std::round((eps0 * N - ph) / (2 * PI));
    return (ph + 2 * PI * k) / N;
  }

  // seg[m] = x(start + m*ratio) with a 16 tap windowed sinc (polyphase table, linear interpolation between phases)
  bool resample(int64_t start, size_t count, double ratio, std::vector<cf> &seg) {
    static std::vector<float> tab; const int PH = 256, TP = 16;
    if (tab.empty()) {
      tab.assign((PH + 1) * TP, 0.f);
      for (int p = 0; p <= PH; p++) for (int k = 0; k < TP; k++) {
        double d = (k - (TP / 2 - 1)) - (double)p / PH;          // tap position relative to the sample
        double h = d == 0 ? 1.0 : sin(PI * d) / (PI * d);
        double w = 0.5 + 0.5 * cos(PI * d / (TP / 2));
        tab[p * TP + k] = (float)(h * w);
      }
    }
    int64_t last = start + (int64_t)(count * ratio) + TP;
    if (start - TP < base_ || last - base_ > (int64_t)buf_.size()) return false;
    seg.assign(count, cf());
    for (size_t m = 0; m < count; m++) {
      double t = (double)m * ratio; int64_t i0 = (int64_t)floor(t); double fr = t - i0;
      double pf = fr * PH; int p = (int)pf; float a = (float)(pf - p);
      const cf *x = &buf_[start + i0 - (TP / 2 - 1) - base_];
      const float *h0 = &tab[p * TP], *h1 = &tab[(p + 1) * TP];
      float re = 0, im = 0;
      for (int k = 0; k < TP; k++) { float h = h0[k] + a * (h1[k] - h0[k]); re += h * x[k].real(); im += h * x[k].imag(); }
      seg[m] = cf(re, im);
    }
    return true;
  }

  void finish(int64_t p1pos, int64_t frameLen, double eps) {
    if (lastP1_ >= 0 && lastLen_ == frameLen) {
      double meas = (double)(p1pos - lastP1_);
      double r = meas / (double)frameLen;
      if (r > 0.9995 && r < 1.0005) period_ = r;
    }
    st.cfoHz = eps * fs0() / (2 * PI);
    eps_ = eps; lastP1_ = p1pos; lastLen_ = frameLen;
    expect_ = p1pos + (int64_t)llround(frameLen * (period_ > 0 ? period_ : 1.0));
    scanPos_ = expect_ - 6144;
  }
};

}  // namespace dvbofdm
