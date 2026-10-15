// DVB-T2 receiver: IQ at the nominal sample rate -> transport stream of one PLP.
#pragma once
#include "common.h"
#include "t2p1.h"
#include "t2demod.h"
#include "t2plp.h"
#include <string>
#include <map>
#include <memory>

namespace dvbofdm {

struct T2Status {
  bool lock = false;           // P1 found, L1 CRC ok in the last frame
  bool fecOk = false;          // FEC blocks of the selected PLP decoded
  int fftSize = 0, giIdx = -1, mod = -1, cod = -1, plpId = -1, pp = 0, ext = 0, rot = 0, fecLong = 0;
  double cfoHz = 0, snrDb = 0, delay = 0;
  uint64_t frames = 0, framesOk = 0, blocks = 0, blocksOk = 0, blocksFix = 0, ts = 0, packets = 0;
  int numPlp = 0;
  std::string text;
};

class T2Receiver {
 public:
  struct Config { double bwMhz = 8; int plp = -1; bool tiBigFirst = false; };
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

 private:
  std::vector<cf> buf_; int64_t base_ = 0;
  int64_t scanPos_ = 0;                  // absolute index to continue the P1 search from
  P1 p1_; L1Decoder l1_; PlpDecoder plp_;
  std::map<std::string, std::unique_ptr<T2Setup>> cache_;
  const T2Setup *Sp_ = nullptr; bool haveS_ = false;
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
  double eps_ = 0, period_ = 0;          // CFO rad/sample; measured frame period / nominal
  int64_t lastP1_ = -1; int64_t lastLen_ = 0;
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
      if (!pi.ok) { scanPos_ = pos + 1024; continue; }
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
    double eps = pi.cfo;
        int64_t p2 = p1pos + 2048;
    L1Pre pre; bool got = false;
    // L1-pre: reuse the previous setup first, otherwise try the guard interval / extended carrier hypotheses
    int tries = 0;
    for (int pass = 0; pass < 2 && !got; pass++) {
      for (int gi = 0; gi < 7 && !got; gi++) for (int ext = 0; ext < 2 && !got; ext++) {
        if (pass == 0) { if (!(haveS_ && Sp_->fftIdx == fftIdx && gi == Sp_->giIdx && ext == Sp_->ext)) continue; }
        else if (haveS_ && Sp_->fftIdx == fftIdx && gi == Sp_->giIdx && ext == Sp_->ext) continue;
        const T2Setup &s0 = getSetup(fftIdx, gi, ext, miso, 1, 0, 1, 0);
        int64_t need = p2 + (int64_t)s0.st->N_P2 * (s0.N + s0.G) + 16;
        if (need - base_ > (int64_t)buf_.size()) return 0;
        T2FrameCells fc;
        if (!T2Demod::run(buf_, base_, s0, p2, eps, s0.N + s0.G, s0.G / 2, fc, true)) return 0;
        int NP = s0.st->N_P2;
        std::vector<cf> c(1840); std::vector<float> w(1840);
        for (int s = 0; s < NP; s++) for (int j = 0; j < 1840 / NP; j++) { c[s + j * NP] = fc.cell[s][j]; w[s + j * NP] = fc.wgt[s][j]; }
        tries++;
        if (l1_.decodePre(c.data(), w.data(), pre)) {
          got = true;
          double e = 0; for (int i = 0; i < 1840; i++) { cf d = c[i] - cf(c[i].real() >= 0 ? 1.f : -1.f, 0); e += cabs2(d); }
          st.snrDb = 10 * log10(1840.0 / std::max(e, 1e-9));
        }
      }
    }
    if (!got) return -1;
    Sp_ = &getSetup(fftIdx, pre.gi, pre.bwtExt, miso, pre.pp, pre.papr, pre.nData, pre.ver);
    const T2Setup &S_ = *Sp_;
    haveS_ = true;
    const int symLen = S_.N + S_.G;
    int64_t frameLen = 2048 + (int64_t)S_.numSymbols() * symLen;
    // timing from the previous frame: the window start moves with the measured delay
    if (p2 + (int64_t)S_.numSymbols() * symLen + 16 - base_ > (int64_t)buf_.size()) return 0;
    st.frames++;
    back_ = S_.G / 2;
    double spacing = symLen * (period_ > 0 ? period_ : 1.0);
    T2FrameCells fc;
    T2Demod::run(buf_, base_, S_, p2, eps, spacing, back_, fc);
    // second pass with the timing measured on the pilots (window should start 'back' samples before the useful part)
    double corr = fc.delay - back_;
    if (fabs(corr) > 2) {
      p2 += (int64_t)llround(corr);
      if (p2 + (int64_t)S_.numSymbols() * symLen + 16 - base_ > (int64_t)buf_.size()) { p2 -= (int64_t)llround(corr); }
      else T2Demod::run(buf_, base_, S_, p2, eps, spacing, back_, fc);
    }
    st.delay = fc.delay;
    // L1-post
    int NP = S_.st->N_P2, npc = pre.postSize;
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
    // PLP selection
    const PlpCfg *sel = nullptr;
    if (cfg.plp >= 0) { for (auto &p : post.plp) if (p.id == cfg.plp) sel = &p; }
    else { for (auto &p : post.plp) if (p.type != 0) { sel = &p; break; } if (!sel && !post.plp.empty()) sel = &post.plp[0]; }
    if (sel && sel->blocks > 0) {
      plp_.bigFirst = cfg.tiBigFirst;
      if (plp_.configure(*sel)) {
        st.plpId = sel->id; st.mod = sel->mod; st.cod = sel->cod; st.rot = sel->rot; st.fecLong = (sel->fec & 3) == 1;
        T2Stream str; buildStream(fc, pre, str);
        size_t need = (size_t)sel->blocks * plp_.fec.ncell;
        if ((size_t)sel->start + need <= str.cell.size() && sel->type != 2) {
          size_t before = ts.size();
          int b0 = plp_.st.blocks, o0 = plp_.st.ok, f0 = plp_.st.fixed;
          plp_.decodeFrame(str.cell.data() + sel->start, str.w.data() + sel->start, sel->blocks, ts);
          st.blocks += plp_.st.blocks - b0; st.blocksOk += plp_.st.ok - o0; st.blocksFix += plp_.st.fixed - f0;
          st.ts += ts.size() - before; st.packets = plp_.bb.packets;
          st.fecOk = (plp_.st.ok - o0) == (plp_.st.blocks - b0);
        } else st.text = sel->type == 2 ? "type 2 PLP not supported yet" : "PLP outside the frame";
      }
    }
    finish(p1pos, frameLen, eps);
    return 1;
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
