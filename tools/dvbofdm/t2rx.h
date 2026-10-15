// DVB-T2 receiver: IQ at the nominal sample rate -> transport stream of one PLP.
#pragma once
#include "common.h"
#include "t2p1.h"
#include "t2demod.h"
#include "t2plps.h"
#include <string>
#include <map>
#include <memory>
#include <cstring>

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

  // ---- frame level parallelism. The preamble search, L1-pre and the assembly of the transport stream stay here; a whole frame (demodulation,
  // L1-post, FEC) is a job that any pool worker can run. The host takes the jobs from jobsOut, runs them with runJob() on other instances
  // and hands the results back to result() in any order; they are applied in the order of the frames.
  void setParallel(bool on, uint32_t epoch) { par_ = on; serial_ = false; epoch_ = epoch; seq_ = apply_ = 0; pending_.clear(); jobsOut.clear(); }
  std::vector<std::vector<uint8_t>> jobsOut;
  bool serial() const { return serial_; }

  void result(const uint8_t *blob, size_t n) {
    ResHdr h;
    if (n < sizeof h) return;
    memcpy(&h, blob, sizeof h);
    if (h.magic != kResMagic || h.epoch != epoch_ || h.seq < apply_) return;
    pending_[h.seq].assign(blob, blob + n);
    while (!pending_.empty()) {
      if (pending_.begin()->first != apply_) { if (pending_.size() > 12) apply_ = pending_.begin()->first; else break; }   // a lost result must not stall the rest
      std::vector<uint8_t> b = std::move(pending_.begin()->second);
      pending_.erase(pending_.begin()); apply_++;
      applyOne(b);
    }
  }

  // pool worker side: decodes one frame job, returns the result blob
  void runJob(const uint8_t *blob, size_t n, std::vector<uint8_t> &out) {
    JobHdr h; memcpy(&h, blob, sizeof h);
    const cf *x = reinterpret_cast<const cf *>(blob + sizeof h);
    worker_ = true; plps_.capture = true;
    cfg.bwMhz = h.bwMhz; cfg.plp = h.plp; cfg.mergeCommon = h.mergeCommon != 0; plps_.mergeCommon = cfg.mergeCommon;
    buf_.assign(x, x + h.nSamples); base_ = 0; period_ = h.period;
    plps_.blocks.clear(); plps_.last.clear(); plps_.needSerial = false;
    for (int i = 0; i < h.nBig && i < 8; i++) plps_.run[h.bigId[i]].dec.bigFirst = h.bigVal[i] != 0;
    st.blocks = st.blocksOk = 0; st.framesOk = 0; st.lock = false; st.text.clear(); st.plps.clear(); st.fecOk = false;
    workerStatus_ = 0; selId_ = commonId_ = -1;
    const T2Setup &S_ = getSetup(h.fftIdx, h.pre.gi, h.pre.bwtExt, h.miso, h.pre.pp, h.pre.papr, h.pre.nData, h.pre.ver);
    Sp_ = &S_; haveS_ = true;
    body(0, h.p2rel, h.pre, S_, h.eps, 0);
    ResHdr r; r.epoch = h.epoch; r.seq = h.seq; r.status = workerStatus_;
    r.snr = st.snrDb; r.delay = st.delay; r.sfo = st.sfoPpm;
    r.selId = selId_; r.commonId = commonId_; r.mod = st.mod; r.cod = st.cod; r.rot = st.rot; r.fecLong = st.fecLong;
    r.fftSize = st.fftSize; r.giIdx = st.giIdx; r.pp = st.pp; r.ext = st.ext; r.numPlp = st.numPlp; r.frameIdx = st.frameIdx;
    r.nPlps = (int32_t)st.plps.size(); r.textLen = (int32_t)st.text.size();
    int ids[2] = {selId_, commonId_};
    r.nOut = 0; for (int k = 0; k < 2; k++) if (r.status == 1 && ids[k] >= 0) r.nOut++;
    out.assign(sizeof r, 0);
    out.insert(out.end(), reinterpret_cast<const uint8_t *>(st.plps.data()), reinterpret_cast<const uint8_t *>(st.plps.data()) + st.plps.size() * sizeof(PlpCfg));
    out.insert(out.end(), st.text.begin(), st.text.end());
    if (r.status == 1) for (int k = 0; k < 2; k++) {
      if (ids[k] < 0) continue;
      PlpOutHdr o; o.id = ids[k]; o.isCommon = k; o.kbch = plps_.run[ids[k]].dec.fec.kbch;
      auto it = plps_.last.find(ids[k]); o.nb = it == plps_.last.end() ? 0 : it->second.first; o.no = it == plps_.last.end() ? 0 : it->second.second;
      const auto &bl = plps_.blocks[ids[k]]; o.nStored = (int32_t)bl.size();
      const uint8_t *po = reinterpret_cast<const uint8_t *>(&o);
      out.insert(out.end(), po, po + sizeof o);
      for (const auto &b : bl) out.insert(out.end(), b.begin(), b.end());
    }
    memcpy(out.data(), &r, sizeof r);
    buf_.clear(); buf_.shrink_to_fit();
  }

  // an empty result for a job that was not run (the pool was busy): keeps the order
  static void dropResult(uint32_t epoch, uint32_t seq, std::vector<uint8_t> &out) {
    ResHdr r; r.epoch = epoch; r.seq = seq; r.status = 0;
    out.assign(reinterpret_cast<uint8_t *>(&r), reinterpret_cast<uint8_t *>(&r) + sizeof r);
  }

 private:
  static constexpr uint32_t kJobMagic = 0x4a4f4231, kResMagic = 0x52455331;
  struct JobHdr {
    uint32_t magic = kJobMagic, epoch = 0, seq = 0;
    int32_t fftIdx = 0, miso = 0, p2rel = 0, nSamples = 0, plp = -1, mergeCommon = 1, nBig = 0;
    int32_t bigId[8] = {}, bigVal[8] = {};
    double eps = 0, period = 0, bwMhz = 8;
    L1Pre pre;
  };
  struct ResHdr {
    uint32_t magic = kResMagic, epoch = 0, seq = 0;
    int32_t status = 0;          // 0 not run, 1 decoded, 2 L1-post failed, 3 needs the previous frames (serial decoding)
    double snr = 0, delay = 0, sfo = 0;
    int32_t selId = -1, commonId = -1, mod = -1, cod = -1, rot = 0, fecLong = 0, fftSize = 0, giIdx = -1, pp = 0, ext = 0, numPlp = 0, frameIdx = 0;
    int32_t nPlps = 0, textLen = 0, nOut = 0;
  };
  struct PlpOutHdr { int32_t id = 0, isCommon = 0, kbch = 0, nb = 0, no = 0, nStored = 0; };
  bool par_ = false, serial_ = false, worker_ = false;
  unsigned probeRound_ = 0;
  uint32_t epoch_ = 0, seq_ = 0, apply_ = 0;
  std::map<uint32_t, std::vector<uint8_t>> pending_;
  int workerStatus_ = 0, selId_ = -1, commonId_ = -1;

  void dispatch(int64_t p1pos, int64_t p2, const L1Pre &pre, int fftIdx, int miso, const T2Setup &S_, double eps) {
    (void)p1pos;
    const int symLen = S_.N + S_.G;
    int64_t a = std::max(p2 - 96, base_), b = std::min(base_ + (int64_t)buf_.size(), p2 + (int64_t)S_.numSymbols() * symLen + 5400);
    JobHdr h; h.epoch = epoch_; h.seq = seq_++; h.fftIdx = fftIdx; h.miso = miso; h.p2rel = (int32_t)(p2 - a); h.nSamples = (int32_t)(b - a);
    h.plp = cfg.plp; h.mergeCommon = cfg.mergeCommon ? 1 : 0; h.eps = eps; h.period = period_; h.bwMhz = cfg.bwMhz; h.pre = pre;
    for (auto &kv : plps_.run) if (h.nBig < 8) { h.bigId[h.nBig] = kv.first; h.bigVal[h.nBig] = kv.second.dec.bigFirst ? 1 : 0; h.nBig++; }
    std::vector<uint8_t> blob(sizeof h + (size_t)h.nSamples * sizeof(cf));
    memcpy(blob.data(), &h, sizeof h);
    memcpy(blob.data() + sizeof h, &buf_[a - base_], (size_t)h.nSamples * sizeof(cf));
    jobsOut.push_back(std::move(blob));
  }

  void applyOne(const std::vector<uint8_t> &b) {
    ResHdr h; memcpy(&h, b.data(), sizeof h);
    if (h.status == 0) return;
    if (h.status == 3) { serial_ = true; return; }
    size_t off = sizeof h;
    std::vector<PlpCfg> plps(h.nPlps);
    if (h.nPlps) memcpy(plps.data(), &b[off], h.nPlps * sizeof(PlpCfg));
    off += h.nPlps * sizeof(PlpCfg);
    std::string text(reinterpret_cast<const char *>(&b[off]), h.textLen); off += h.textLen;
    st.snrDb = h.snr; st.delay = h.delay; st.sfoPpm = h.sfo;
    if (h.status == 2) { st.lock = false; st.text = text.empty() ? "L1-post CRC failed" : text; return; }
    st.lock = true; st.framesOk++;
    st.fftSize = h.fftSize; st.giIdx = h.giIdx; st.pp = h.pp; st.ext = h.ext; st.numPlp = h.numPlp; st.frameIdx = h.frameIdx; st.plps = plps;
    int nb = 0, no = 0;
    for (int k = 0; k < h.nOut; k++) {
      PlpOutHdr o; memcpy(&o, &b[off], sizeof o); off += sizeof o;
      PlpRun &r = plps_.run[o.id];
      const size_t pk = (size_t)(o.kbch + 7) / 8;
      std::vector<uint8_t> bits(o.kbch);
      for (int j = 0; j < o.nStored; j++, off += pk) {
        for (int i = 0; i < o.kbch; i++) bits[i] = (b[off + (i >> 3)] >> (7 - (i & 7))) & 1;
        r.dec.bb.process(bits.data(), o.kbch, r.out);
      }
      nb += o.nb; no += o.no;
      // none of a good number of blocks decoded: the other order of the time interleaver blocks may be the right one
      if (o.nb >= 8 && o.no == 0) { if (++r.idleBad >= 2) { r.dec.bigFirst = !r.dec.bigFirst; r.idleBad = 0; } } else if (o.no > 0) r.idleBad = 0;
    }
    st.plpId = h.selId; st.mod = h.mod; st.cod = h.cod; st.rot = h.rot; st.fecLong = h.fecLong;
    st.blocks += nb; st.blocksOk += no; st.fecOk = nb > 0 && no == nb;
    if (!text.empty()) st.text = text;
    if (h.selId >= 0) emit(h.selId, h.commonId);
  }

  std::vector<cf> buf_; int64_t base_ = 0;
  int64_t scanPos_ = 0;                  // absolute index to continue the P1 search from
  P1 p1_; L1Decoder l1_; PlpSet plps_;
  std::map<std::string, std::unique_ptr<T2Setup>> cache_;
  const T2Setup *Sp_ = nullptr; bool haveS_ = false;
  int64_t pend_ = -1; L1Pre pendPre_; double pendEps_ = 0;   // L1-pre of the preamble that is waiting for the rest of its frame
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
  int64_t lastP1_ = -1; int64_t lastLen_ = 0; unsigned giRound_ = 0, searchRound_ = 0;
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
    // the same preamble is looked at again with every chunk until the whole frame has arrived: L1-pre is decoded once
    if (pend_ == p1pos) { pre = pendPre_; eps = pendEps_; got = true; }
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
    struct Cand { double sn; std::vector<cf> c; std::vector<float> w; double epsH; };
    std::vector<Cand> cands; double lastSn = -99;
    for (int pass = 0; pass < 2 && !got; pass++) {
      // no setup known yet and nothing decoded so far: the full search of layouts costs about 100 ms, so only every third preamble gets it
      if (pass == 1 && !haveS_ && (searchRound_++ % 3) != 0) break;
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
        for (int al = 0; al < 3; al++) {
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
            lastSn = sn;
            if (sn > st.preSnr) { st.preSnr = sn; st.preGi = gi; st.preExt = ext; st.prePapr = tr; }
          }
          tries++;
          cands.push_back({lastSn, std::move(c), std::move(w), epsH});
        }
      }
      // the LDPC is the expensive part: only the two layouts whose cells look most like BPSK are decoded
      std::sort(cands.begin(), cands.end(), [](const Cand &a, const Cand &b) { return a.sn > b.sn; });
      for (size_t k = 0; k < cands.size() && k < 2 && !got; k++) {
        if (cands[k].sn < 0) break;
        if (l1_.decodePre(cands[k].c.data(), cands[k].w.data(), pre)) {
          got = true; eps = cands[k].epsH; trackEps_ = eps; haveEps_ = true;
          // noise power before equalisation: |z - s|^2 is sigma^2/|H|^2, times the weight |H|^2
          double e = 0, mw = 0;
          for (int i = 0; i < 1840; i++) { cf d = cands[k].c[i] - cf(cands[k].c[i].real() >= 0 ? 1.f : -1.f, 0); e += cands[k].w[i] * cabs2(d); mw += cands[k].w[i]; }
          n0_ = std::max(1e-12, e / 1840.0);
          st.snrDb = 10 * log10(std::max(mw / 1840.0, 1e-12) / n0_);
        }
      }
      cands.clear();
    }
    if (!got) { st.preBad++; haveEps_ = false; pend_ = -1; return -1; }
    pend_ = p1pos; pendPre_ = pre; pendEps_ = eps;
    Sp_ = &getSetup(fftIdx, pre.gi, pre.bwtExt, miso, pre.pp, pre.papr, pre.nData, pre.ver);
    const T2Setup &S_ = *Sp_;
    haveS_ = true;
    const int symLen = S_.N + S_.G;
    int64_t frameLen = 2048 + (int64_t)S_.numSymbols() * symLen;
    // timing from the previous frame: the window start moves with the measured delay
    if (p2 + (int64_t)S_.numSymbols() * symLen + 5200 - base_ > (int64_t)buf_.size()) return 0;   // + room for resampling
    st.frames++;
    if (par_ && !serial_) {
      // with a signal far too weak for the mode (known from an earlier frame) nothing decodes: only every fourth frame goes to the pool, as a probe
      if (!hopeless(st.mod, st.cod) || (probeRound_++ & 3) == 0) dispatch(p1pos, p2, pre, fftIdx, miso, S_, eps);
      finish(p1pos, frameLen, eps); return 1;
    }
    body(p1pos, p2, pre, S_, eps, frameLen);
    return 1;
  }

  // From the timing / CFO refinement to the transport stream. In a pool worker (worker_) it stops at the decoded FEC blocks.
  void body(int64_t p1pos, int64_t p2, const L1Pre &pre, const T2Setup &S_, double eps, int64_t frameLen) {
    const int symLen = S_.N + S_.G;
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
      workerStatus_ = 2;
      if (!worker_) finish(p1pos, frameLen, eps);
      return;
    }
    st.lock = true; st.framesOk++; workerStatus_ = 1;
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
      for (const PlpCfg *pc : {sel, common}) if (pc) plps_.run[pc->id].dec.lowSnr = hopeless(pc->mod, pc->cod);
      plps_.frame(*sel, post, str, acc, msg);
      if (common) plps_.frame(*common, post, str, acc, msg);
      st.plpId = sel->id; st.mod = sel->mod; st.cod = sel->cod; st.rot = sel->rot; st.fecLong = (sel->fec & 3) == 1;
      st.blocks += acc.blocks; st.blocksOk += acc.ok;
      st.fecOk = acc.blocks > 0 && acc.ok == acc.blocks;
      if (!msg.empty()) st.text = msg;
      if (worker_) { selId_ = sel->id; commonId_ = common ? common->id : -1; if (plps_.needSerial) workerStatus_ = 3; }
      else emit(sel->id, common ? common->id : -1);
    }
    if (!worker_) finish(p1pos, frameLen, eps);
  }

  // the measured SNR is 3 dB or more below what the mode needs (C/N for error-free reception in a Gaussian channel, DVB-T2 implementation guidelines, approximate)
  bool hopeless(int mod, int cod) const {
    static const float need[4][6] = {{1, 2.3f, 3.1f, 4.1f, 4.7f, 5.2f}, {6, 7.5f, 8.7f, 9.9f, 10.7f, 11.3f}, {8.9f, 11, 12.4f, 14.1f, 15.1f, 16}, {12, 14.5f, 16.4f, 18.4f, 19.8f, 20.9f}};
    return mod >= 0 && mod < 4 && cod >= 0 && cod < 6 && st.snrDb < need[mod][cod] - 3;
  }

  // transport stream of the selected PLP (merged with its common PLP) of the frame just decoded
  void emit(int selId, int commonId) {
    PlpRun &r = plps_.run[selId];
    if (commonId >= 0) PlpSet::mergeCommonPackets(r.out, plps_.run[commonId].out);
    st.ts += r.out.size(); ts.insert(ts.end(), r.out.begin(), r.out.end()); r.out.clear();
    if (commonId >= 0 && plps_.run[commonId].out.size() > (1u << 22)) plps_.run[commonId].out.clear();
    st.packets = r.dec.bb.packets; st.tiSwap = r.dec.bigFirst;
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
