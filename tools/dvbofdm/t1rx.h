// DVB-T receiver (EN 300 744): IQ at the nominal sample rate -> transport stream.
// 2K / 8K, all guard intervals, QPSK / 16QAM / 64QAM, all code rates, non-hierarchical.
// Chain: CP correlation (mode, guard interval, timing, fractional CFO) -> integer CFO from continual pilots -> tracking
// (continual pilot phase, window position) -> TPS (frame sync, parameters) -> channel estimate from scattered pilots
// -> symbol / bit deinterleaving -> soft demapping -> Viterbi -> Reed-Solomon -> TS.
#pragma once
#include "common.h"
#include "t1fec.h"
#include "t1_gen.h"
#include <string>
#include <cstdio>
#include <cstdlib>

namespace dvbofdm {

struct T1Status {
  bool lock = false;          // TPS found and good TS packets flow
  bool tps = false;
  int fftSize = 0, giIdx = -1, mod = -1, cod = -1, hier = 0, frame = 0, cell = -1;
  double cfoHz = 0, snrDb = 0, delay = 0, sfoPpm = 0, coh = 0;
  uint64_t symbols = 0, packets = 0, rsFixed = 0, rsFail = 0, syncs = 0, tpsOk = 0;
  std::string text;
};

// Per transmission mode tables
struct T1Tab {
  int N = 0, K = 0, nData = 0, zl = 0;
  std::vector<int> cont, tps;
  std::vector<float> ref;                 // pilot value (+-4/3) per carrier 0..K
  std::vector<int> H;                     // symbol interleaver
  std::vector<int> data[4];               // data carriers per scattered pilot phase
  std::vector<uint8_t> kind[4];           // 0 data, 1 scattered, 2 continual, 3 TPS
  std::vector<float> tpsRef;

  void init(int n) {
    N = n; K = n == 2048 ? 1704 : 6816;
    if (n == 2048) { cont.assign(T1_CP_2K, T1_CP_2K + 45); tps.assign(T1_TPS_2K, T1_TPS_2K + 17); }
    else { cont.assign(T1_CP_8K, T1_CP_8K + 177); tps.assign(T1_TPS_8K, T1_TPS_8K + 68); }
    ref.assign(K + 1, 0.f);
    unsigned reg = (1u << 11) - 1;
    for (int k = 0; k <= K; k++) {
      int w = reg & 1;
      ref[k] = w ? -4.f / 3.f : 4.f / 3.f;
      unsigned nb = ((reg >> 2) ^ reg) & 1; reg = (reg >> 1) | (nb << 10);
    }
    for (int m = 0; m < 4; m++) {
      kind[m].assign(K + 1, 0);
      for (int k = 3 * m; k <= K; k += 12) kind[m][k] = 1;
      for (int c : cont) kind[m][c] = 2;
      for (int t : tps) kind[m][t] = 3;
      data[m].clear();
      for (int k = 0; k <= K; k++) if (kind[m][k] == 0) data[m].push_back(k);
    }
    nData = (int)data[0].size();
    // symbol interleaver (Nr bits, bit permutation of the PRBS state)
    static const char p2k[10] = {4, 3, 9, 6, 2, 8, 1, 5, 7, 0};
    static const char p8k[12] = {7, 1, 4, 2, 9, 6, 8, 10, 0, 3, 11, 5};
    int Nr = n == 2048 ? 11 : 13;
    const char *bp = n == 2048 ? p2k : p8k;
    int target = n == 2048 ? 1512 : 6048;
    H.clear();
    int reg2 = 0, mask = (1 << Nr) - 1;
    for (int i = 0; i < n; i++) {
      if (i == 0 || i == 1) reg2 = 0;
      else if (i == 2) reg2 = 1;
      else {
        int nb = n == 2048 ? ((reg2 ^ (reg2 >> 3)) & 1) : ((reg2 ^ (reg2 >> 1) ^ (reg2 >> 4) ^ (reg2 >> 6)) & 1);
        reg2 = ((reg2 >> 1) | (nb << (Nr - 2))) & mask;
      }
      int nr = 0;
      for (int k = 0; k < Nr - 1; k++) nr |= ((reg2 >> k) & 1) << bp[k];
      int h = ((i % 2) << (Nr - 1)) + nr;
      if (h < target) H.push_back(h);
    }
  }
};

// Constellation (unit average power) and its per-axis level tables
struct T1Cstln {
  int v = 0;
  std::vector<cf> pt;
  float lvlI[8], lvlQ[8];
  int na = 0;
  void init(int mod) {
    v = 2 + 2 * mod; int size = 1 << v; int bpa = v / 2; int spa = (int)(sqrt((double)size)) / 2 - 1;
    double norm = v == 2 ? 1 / sqrt(2.0) : v == 4 ? 1 / sqrt(10.0) : 1 / sqrt(42.0);
    pt.assign(size, cf());
    auto gray = [](int a) { return (a >> 1) ^ a; };
    for (int i = 0; i < size; i++) {
      int q = (i >> (2 * (bpa - 1))) & 3, s0 = (q >> 1) ? -1 : 1, s1 = (q & 1) ? -1 : 1;
      int x = (i >> (bpa - 1)) & ((1 << (bpa - 1)) - 1), y = i & ((1 << (bpa - 1)) - 1);
      int xv = 1 + (spa - x) * 2, yv = 1 + (spa - y) * 2;
      int val = (gray(x) << (bpa - 1)) + gray(y);
      x = 0; y = 0;
      for (int j = 0; j < bpa - 1; j++) { x += ((val >> (1 + 2 * j)) & 1) << j; y += ((val >> (2 * j)) & 1) << j; }
      val = (q << (2 * (bpa - 1))) + (x << (bpa - 1)) + y;
      pt[val] = cf((float)(norm * s0 * xv), (float)(norm * s1 * yv));
    }
    na = 1 << bpa;
    for (int a = 0; a < na; a++) {
      int li = 0, lq = 0;
      for (int t = 0; t < bpa; t++) { int b = (a >> (bpa - 1 - t)) & 1; li |= b << (v - 1 - 2 * t); lq |= b << (v - 2 - 2 * t); }
      lvlI[a] = pt[li].real(); lvlQ[a] = pt[lq].imag();
    }
  }
  // soft bits of one axis: out[t], t = 0 .. v/2-1, > 0 means bit 0
  void axisLlr(float x, const float *lvl, float *out) const {
    int bpa = v / 2;
    for (int t = 0; t < bpa; t++) {
      float m0 = 1e30f, m1 = 1e30f;
      for (int a = 0; a < na; a++) {
        float d = (x - lvl[a]); d *= d;
        if ((a >> (bpa - 1 - t)) & 1) { if (d < m1) m1 = d; } else if (d < m0) m0 = d;
      }
      out[t] = m1 - m0;
    }
  }
};

class T1Receiver {
 public:
  struct Config { double bwMhz = 8; };
  Config cfg;
  T1Status st;
  std::vector<uint8_t> ts;

  double fs0() const {
    double b = cfg.bwMhz;
    if (b < 2) return 131e6 / 71.0;
    if (b == 7) return 8e6;
    return b * 8e6 / 7.0;
  }

  void feed(const cf *x, size_t n) {
    buf_.insert(buf_.end(), x, x + n);
    step();
    if (!tsOut_.empty()) { ts.insert(ts.end(), tsOut_.begin(), tsOut_.end()); tsOut_.clear(); }
  }

 private:
  enum State { ACQ, SYNC1, TRACK };
  State state_ = ACQ;
  std::vector<cf> buf_; int64_t base_ = 0;
  T1Tab tab_[2]; bool tabInit_[2] = {false, false};
  const T1Tab *tb_ = nullptr;
  int N_ = 0, G_ = 0, T_ = 0, gdiv_ = 0;
  Fft fft_[2];
  // acquisition result
  int64_t cpPos_ = 0; double epsBins_ = 0;
  int avoidN_ = 0, avoidG_ = 0, avoidCnt_ = 0;
  // tracking
  int64_t win_ = 0; double theta_ = 0, omega_ = 0;
  double lead_ = 0, leadTarget_ = 0;
  double phi_ = 0;
  std::vector<cf> prev_, y_, yc_, ring_[4];
  int ringN_ = 0;
  bool havePrev_ = false;
  uint64_t cnt_ = 0;
  double cohAvg_ = 1; int lowCoh_ = 0;
  std::vector<uint8_t> tpsBits_;
  bool tpsKnown_ = false; int64_t lfBase_ = 0;
  int tpsFail_ = 0;
  uint64_t symSinceSync_ = 0; int64_t shiftSum_ = 0; uint64_t shiftSyms_ = 0;
  uint64_t goodMark_ = 0; int stale_ = 0;
  // decoding chain
  std::vector<cf> Hg_; bool histOk_ = false;
  std::vector<cf> Hall_;
  T1Cstln cs_; int csMod_ = -1;
  T1Punct pun_; T1Viterbi vit_; T1Ts tsd_;
  int rate_ = -1;
  std::vector<uint8_t> tsOut_;
  std::vector<uint8_t> vbits_;
  std::vector<int8_t> coded_, pairs_;
  std::vector<float> llrF_;
  double snrAvg_ = 0; bool snrInit_ = false;

  // ---------------------------------------------------------------- helpers
  const T1Tab &tabFor(int N) {
    int i = N == 2048 ? 0 : 1;
    if (!tabInit_[i]) { tab_[i].init(N); tabInit_[i] = true; fft_[i].init(N); }
    return tab_[i];
  }

  // Window of N samples from absolute position W, rotated by exp(-j(theta + omega i)), FFT in place
  void fftSym(int64_t W, double theta, double omega, cf *out) {
    const cf *x = &buf_[W - base_];
    cf rot((float)cos(-omega), (float)sin(-omega));
    cf ph((float)cos(-theta), (float)sin(-theta));
    for (int i = 0; i < N_; i++) {
      out[i] = x[i] * ph; ph *= rot;
      if ((i & 255) == 255) { float a = 1.f / std::sqrt(cabs2(ph)); ph *= a; }
    }
    fft_[N_ == 2048 ? 0 : 1].run(out);
  }

  void reacquire(bool avoid) {
    state_ = ACQ;
    if (avoid) {
      if (avoidCnt_ < 3 && N_) { avoidN_ = N_; avoidG_ = G_; avoidCnt_++; }
    }
    tpsKnown_ = false; histOk_ = false; havePrev_ = false; ringN_ = 0;
    st.lock = false; st.tps = false; st.text = "searching for a DVB-T signal…";
    scanFrom_ = win_ > base_ ? win_ : base_;
  }
  int64_t scanFrom_ = 0;

  void trim(int64_t keep) {
    if (keep > base_ + 65536) {
      size_t drop = (size_t)(keep - base_);
      if (drop > buf_.size()) drop = buf_.size();
      buf_.erase(buf_.begin(), buf_.begin() + drop);
      base_ += drop;
    }
  }

  // ---------------------------------------------------------------- acquisition: guard interval correlation
  bool cpSearch(const cf *x, int L) {
    struct C { int N, G, n0; double q, e, rho; double arg; } c[8]; int nc = 0;
    const int S = 10;
    static const int GD[4] = {4, 8, 16, 32};
    std::vector<std::complex<double>> P;
    std::vector<double> E;
    for (int ni = 0; ni < 2; ni++) {
      int N = ni == 0 ? 2048 : 8192;
      int M = L - N;
      P.assign(M + 1, 0); E.assign(M + 1, 0);
      for (int n = 0; n < M; n++) {
        std::complex<double> p = std::complex<double>(x[n]) * std::conj(std::complex<double>(x[n + N]));
        P[n + 1] = P[n] + p;
        E[n + 1] = E[n] + 0.5 * (cabs2(x[n]) + cabs2(x[n + N]));
      }
      for (int gi = 0; gi < 4; gi++) {
        int G = N / GD[gi], T = N + G;
        if (S * T + G > M) continue;
        double bq = -1, be = 1, ba = 0; int bn = 0;
        for (int n0 = 0; n0 < T; n0++) {
          std::complex<double> q = 0;
          for (int s = 0; s < S; s++) q += P[n0 + (size_t)s * T + G] - P[n0 + (size_t)s * T];
          double a = std::abs(q);
          if (a > bq) {
            bq = a; bn = n0; ba = std::arg(q);
            double e = 0; for (int s = 0; s < S; s++) e += E[n0 + (size_t)s * T + G] - E[n0 + (size_t)s * T];
            be = e;
          }
        }
        c[nc++] = {N, G, bn, bq, be, be > 0 ? bq / be : 0, ba};
      }
    }
    double rmax = 0; for (int i = 0; i < nc; i++) rmax = std::max(rmax, c[i].rho);
    if (rmax < 0.18) return false;
    double r0 = 0.5 * rmax, bestL = -1e300; int bi = -1;
    for (int i = 0; i < nc; i++) {
      if (c[i].N == avoidN_ && c[i].G == avoidG_ && avoidCnt_) continue;
      double lam = c[i].q - r0 * c[i].e;
      if (lam > bestL) { bestL = lam; bi = i; }
    }
    if (bi < 0 || c[bi].rho < 0.18) return false;
    N_ = c[bi].N; G_ = c[bi].G; T_ = N_ + G_; gdiv_ = N_ / G_;
    cpPos_ = scanFrom_ + c[bi].n0;
    epsBins_ = -c[bi].arg / (2 * PI);
    return true;
  }

  // ---------------------------------------------------------------- step
  void step() {
    for (int guard = 0; guard < 100000; guard++) {
      if (state_ == ACQ) {
        const int L = 120000;
        if (scanFrom_ < base_) scanFrom_ = base_;
        if (base_ + (int64_t)buf_.size() - scanFrom_ < L) { trim(scanFrom_ - 4096); return; }
        if (cpSearch(&buf_[scanFrom_ - base_], L)) {
          tb_ = &tabFor(N_);
          omega_ = 2 * PI * epsBins_ / N_;
          state_ = SYNC1;
        } else {
          scanFrom_ += L / 2;
          if (avoidCnt_ && ++avoidAge_ > 6) { avoidCnt_ = 0; avoidAge_ = 0; }
        }
      } else if (state_ == SYNC1) {
        int r = sync1();
        if (r == 0) { trim(cpPos_ - 4096); return; }
        if (r < 0) { reacquire(false); scanFrom_ = cpPos_ + 60000; }
      } else {
        if (!symbol()) { trim(win_ - 4096 - T_); return; }
      }
    }
  }
  int avoidAge_ = 0;

  // integer carrier offset from the continual pilots, then start tracking
  int sync1() {
    const int NS = 10;
    int64_t W0 = cpPos_ + G_ / 2;
    if (W0 + (int64_t)NS * T_ + N_ - base_ > (int64_t)buf_.size()) return 0;
    std::vector<cf> Y((size_t)NS * N_);
    for (int i = 0; i < NS; i++) fftSym(W0 + (int64_t)i * T_, 0.0, omega_, &Y[(size_t)i * N_]);
    // fftSym restarts the phase per symbol: the phase offset between symbols is common to all carriers and drops out of the differential
    int S = N_ == 2048 ? 100 : 220;
    std::vector<double> M(2 * S + 1, 0.0);
    int half = tb_->K / 2;
    for (int s = -S; s <= S; s++) {
      double tot = 0;
      for (int i = 1; i < NS; i++) {
        cf acc = 0;
        for (int c : tb_->cont) {
          int bin = ((c - half + s) % N_ + N_) % N_;
          acc += Y[(size_t)i * N_ + bin] * std::conj(Y[(size_t)(i - 1) * N_ + bin]);
        }
        tot += std::abs(acc);
      }
      M[s + S] = tot;
    }
    int bs = 0; double bv = -1;
    for (int s = -S; s <= S; s++) if (M[s + S] > bv) { bv = M[s + S]; bs = s; }
    std::vector<double> sorted(M); std::sort(sorted.begin(), sorted.end());
    double med = sorted[sorted.size() / 2];
    // energy of the symbols for a scale-free test
    double en = 0;
    for (int i = 1; i < NS; i++) for (int c : tb_->cont) { int bin = ((c - half + bs) % N_ + N_) % N_; en += std::abs(Y[(size_t)i * N_ + bin]) * std::abs(Y[(size_t)(i - 1) * N_ + bin]); }
    if (bv < 3.0 * med || bv < 0.35 * en) return -1;
    omega_ += 2 * PI * bs / N_;
    // start tracking after the symbols used here
    win_ = W0 + (int64_t)NS * T_;
    theta_ = 0;
    // the fractional / integer offset is applied as a rotation continuing from the window start
    lead_ = G_ / 2.0; leadTarget_ = G_ / 2.0;
    phi_ = 0; havePrev_ = false; cnt_ = 0; cohAvg_ = 1; lowCoh_ = 0;
    tpsBits_.clear(); tpsKnown_ = false; tpsFail_ = 0; histOk_ = false; ringN_ = 0;
    symSinceSync_ = 0; shiftSum_ = 0; shiftSyms_ = 0; stale_ = 0; snrInit_ = false;
    y_.assign(tb_->K + 1, cf()); yc_.assign(tb_->K + 1, cf()); prev_.assign(tb_->K + 1, cf());
    for (auto &r : ring_) r.assign(tb_->K + 1, cf());
    Hg_.assign(tb_->K / 3 + 1, cf()); Hall_.assign(tb_->K + 1, cf());
    st.fftSize = N_; st.giIdx = gdiv_ == 32 ? 0 : gdiv_ == 16 ? 1 : gdiv_ == 8 ? 2 : 3;
    st.text = "DVB-T carrier found, waiting for TPS…";
    avoidAge_ = 0;
    state_ = TRACK;
    return 1;
  }

  // ---------------------------------------------------------------- TPS
  static int tpsBch(const uint8_t *b) {          // b: s1..s67; returns 0 when the BCH code holds
    unsigned reg = 0;
    uint8_t din[113]; memset(din, 0, 60);
    for (int i = 0; i < 53; i++) din[60 + i] = b[i];
    for (int i = 0; i < 113; i++) {
      unsigned fb = 1 & (din[i] ^ reg);
      reg >>= 1; reg |= fb << 13;
      reg ^= (fb << 12) ^ (fb << 11) ^ (fb << 9) ^ (fb << 8) ^ (fb << 7) ^ (fb << 5) ^ (fb << 4);
    }
    for (int i = 0; i < 14; i++) if (b[53 + i] != ((reg >> i) & 1)) return -1;
    return 0;
  }
  static int bitsToInt(const uint8_t *b, int n) { int v = 0; for (int i = 0; i < n; i++) v = (v << 1) | b[i]; return v; }

  struct Tps { int frame, cons, hier, hp, lp, gi, mode, cell, len; };
  bool tpsWindow(Tps &t) const {
    if (tpsBits_.size() < 67) return false;
    const uint8_t *b = &tpsBits_[tpsBits_.size() - 67];
    int sw = bitsToInt(b, 16);
    if (sw != 0x35ee && sw != 0xca11) return false;
    if (tpsBch(b)) return false;
    t.len = bitsToInt(b + 16, 6);
    t.frame = bitsToInt(b + 22, 2);
    t.cons = bitsToInt(b + 24, 2);
    t.hier = bitsToInt(b + 26, 3);
    t.hp = bitsToInt(b + 29, 3);
    t.lp = bitsToInt(b + 32, 3);
    t.gi = bitsToInt(b + 35, 2);
    t.mode = bitsToInt(b + 37, 2);
    t.cell = bitsToInt(b + 39, 8);
    if ((sw == 0xca11) != (t.frame & 1)) return false;
    return true;
  }

  // ---------------------------------------------------------------- one OFDM symbol
  bool symbol() {
    const T1Tab &tb = *tb_;
    if (win_ + N_ - base_ > (int64_t)buf_.size()) return false;
    static std::vector<cf> Y; Y.resize(N_);
    fftSym(win_, theta_, omega_, Y.data());
    int half = tb.K / 2;
    for (int k = 0; k <= tb.K; k++) y_[k] = Y[((k - half) % N_ + N_) % N_];
    // continual pilots: phase advance since the previous symbol
    double delta = 0, coh = 1;
    if (havePrev_) {
      cf acc = 0; double en = 0;
      for (int c : tb.cont) { acc += y_[c] * std::conj(prev_[c]); en += std::abs(y_[c]) * std::abs(prev_[c]); }
      delta = std::arg(acc); coh = en > 0 ? std::abs(acc) / en : 0;
      phi_ += delta;
      cohAvg_ = 0.95 * cohAvg_ + 0.05 * coh;
    }
    cf rot((float)cos(-phi_), (float)sin(-phi_));
    for (int k = 0; k <= tb.K; k++) yc_[k] = y_[k] * rot;
    // TPS bit by differential detection against the previous (phase-corrected) symbol
    if (havePrev_) {
      double d = 0;
      for (int t : tb.tps) d += (yc_[t] * std::conj(ring_[(ringN_ + 3) & 3][t])).real();
      tpsBits_.push_back(d < 0 ? 1 : 0);
      if (tpsBits_.size() > 200) tpsBits_.erase(tpsBits_.begin(), tpsBits_.begin() + 100);
    }
    // ring of the last four corrected symbols (slot ringN_ & 3 gets the current one)
    int slot = ringN_ & 3;
    ring_[slot] = yc_;
    ringN_++;
    prev_ = y_;
    havePrev_ = true;
    cnt_++; st.symbols++;
    if (getenv("T1DBG") && cnt_ < 200) fprintf(stderr, "sym %llu delta %.3f coh %.2f omega %.6f win %lld known %d lead %.1f slope %.3f\n", (unsigned long long)cnt_, delta, coh, omega_, (long long)win_, (int)tpsKnown_, lead_, slope_);

    Tps t;
    if (!tpsKnown_) {
      if (tpsBits_.size() >= 67 && tpsWindow(t) && tpsAccept(t)) {
        tpsKnown_ = true; lfBase_ = (int64_t)cnt_ - 1;     // this symbol is number 67 of the frame
        buildHist();
        st.text = "";
      } else if (cnt_ > 68 * 6) {
        reacquire(true); return true;
      }
    } else {
      int lf = (int)((((int64_t)cnt_ - 1 - lfBase_ + 67) % 68 + 68) % 68);
      if (histOk_) {
        updateHist(lf & 3);
        decodeSymbol(lf);
      } else buildHist();
      if (lf == 67) {
        if (tpsWindow(t) && t.mode == (N_ == 2048 ? 0 : 1)) { tpsFail_ = 0; st.tpsOk++; st.frame = t.frame; if (t.cons != st.mod || cod(t.hp) != st.cod) tpsAccept(t); }
        else tpsFail_++;
        // lost: nothing good for a long time
        if (tsd_.packets != goodMark_) { goodMark_ = tsd_.packets; stale_ = 0; } else stale_++;
        st.packets = tsd_.packets; st.rsFixed = tsd_.rsFixed; st.rsFail = tsd_.rsFail;
        st.lock = stale_ < 3 && tpsFail_ < 6 && tsd_.packets > 0;
        if (tpsFail_ >= 12 || stale_ >= 30) { reacquire(true); return true; }
      }
    }
    st.coh = cohAvg_;
    if (cohAvg_ < 0.2) { if (++lowCoh_ > 60) { reacquire(false); return true; } } else lowCoh_ = 0;

    // timing and frequency loops
    if (tpsKnown_ && histOk_ && slopeFresh_) trackWindow();
    slopeFresh_ = false;
    omega_ += 0.3 * delta / T_;
    theta_ += omega_ * T_;
    theta_ = std::fmod(theta_, 2 * PI);
    win_ += T_;
    st.cfoHz = omega_ * fs0() / (2 * PI);
    return true;
  }

  static int cod(int r) { return r; }

  bool tpsAccept(const Tps &t) {
    int mode = N_ == 2048 ? 0 : 1;
    int giIdx = t.gi;                                   // 0 1/32, 1 1/16, 2 1/8, 3 1/4
    int gm = gdiv_ == 32 ? 0 : gdiv_ == 16 ? 1 : gdiv_ == 8 ? 2 : 3;
    if (t.mode != mode || giIdx != gm) { reacquire(true); return false; }
    if (t.cons > 2 || t.hp > 4) return false;
    st.tps = true; st.mod = t.cons; st.cod = t.hp; st.hier = t.hier; st.frame = t.frame; st.cell = t.len == 31 ? t.cell : -1;
    st.giIdx = giIdx; st.fftSize = N_;
    if (t.hier != 0) { st.text = "hierarchical modulation is not supported"; }
    if (csMod_ != t.cons) { cs_.init(t.cons); csMod_ = t.cons; }
    if (rate_ != t.hp) { pun_.init(t.hp); rate_ = t.hp; }
    vit_.reset(); tsd_.reset();
    return true;
  }

  // fills the channel grid from the last four symbols (this one has pattern 3, the earlier ones 2, 1, 0)
  void buildHist() {
    if (ringN_ < 4) { histOk_ = false; return; }
    const T1Tab &tb = *tb_;
    std::fill(Hg_.begin(), Hg_.end(), cf());
    for (int j = 0; j < 4; j++) {
      const std::vector<cf> &r = ring_[(ringN_ - 4 + j) & 3];
      int m = j;
      for (int k = 3 * m; k <= tb.K; k += 12) Hg_[k / 3] = r[k] * (tb.ref[k] > 0 ? 0.75f : -0.75f);
    }
    const std::vector<cf> &r = ring_[(ringN_ - 1) & 3];
    for (int c : tb.cont) Hg_[c / 3] = r[c] * (tb.ref[c] > 0 ? 0.75f : -0.75f);
    histOk_ = true;
  }

  void updateHist(int m) {
    const T1Tab &tb = *tb_;
    for (int k = 3 * m; k <= tb.K; k += 12) Hg_[k / 3] = yc_[k] * (tb.ref[k] > 0 ? 0.75f : -0.75f);
    for (int c : tb.cont) Hg_[c / 3] = yc_[c] * (tb.ref[c] > 0 ? 0.75f : -0.75f);
  }

  double slope_ = 0; bool slopeFresh_ = false;
  // interpolates the grid (every third carrier) to all carriers after removing the common delay slope
  void interpolate() {
    const T1Tab &tb = *tb_;
    int NG = (int)Hg_.size();
    cf acc = 0;
    for (int g = 1; g < NG; g++) acc += Hg_[g] * std::conj(Hg_[g - 1]);
    double psi = std::arg(acc);
    slope_ = psi; slopeFresh_ = true;
    if (getenv("T1DBG2") && cnt_ < 135) { fprintf(stderr, "Hg sym %llu psi %.4f:", (unsigned long long)cnt_, psi); for (int g = 0; g < 14; g++) fprintf(stderr, " (%.2f,%.2f)", Hg_[g].real(), Hg_[g].imag()); fprintf(stderr, "\n"); }
    static std::vector<cf> Hs; Hs.resize(NG);
    for (int g = 0; g < NG; g++) { double a = -psi * g; Hs[g] = Hg_[g] * cf((float)cos(a), (float)sin(a)); }
    // polyphase windowed-sinc, 12 taps, fractions 1/3 and 2/3
    static float coef[3][12]; static bool init = false;
    if (!init) {
      for (int r = 0; r < 3; r++) for (int i = 0; i < 12; i++) {
        double f = r / 3.0, d = (i - 5) - f;           // tap i is at grid offset i-5
        double s = fabs(d) < 1e-9 ? 1.0 : sin(PI * d) / (PI * d);
        double w = 0.5 + 0.5 * cos(PI * d / 6.0);
        coef[r][i] = (float)(s * w);
      }
      for (int r = 0; r < 3; r++) { double sum = 0; for (int i = 0; i < 12; i++) sum += coef[r][i]; for (int i = 0; i < 12; i++) coef[r][i] = (float)(coef[r][i] / sum); }
      init = true;
    }
    for (int g = 0; g < NG; g++) {
      for (int r = 0; r < 3; r++) {
        int k = 3 * g + r; if (k > tb.K) break;
        cf v;
        if (r == 0) v = Hs[g];
        else {
          float re = 0, im = 0;
          for (int i = 0; i < 12; i++) { int gg = g + i - 5; gg = gg < 0 ? 0 : gg >= NG ? NG - 1 : gg; re += coef[r][i] * Hs[gg].real(); im += coef[r][i] * Hs[gg].imag(); }
          v = cf(re, im);
        }
        double a = psi * k / 3.0;
        Hall_[k] = v * cf((float)cos(a), (float)sin(a));
      }
    }
  }

  // window position: the delay slope of the channel tells how far the window sits before the useful part
  void trackWindow() {
    double lead = -slope_ * N_ / (6 * PI);
    if (!std::isfinite(lead)) return;
    lead_ = 0.9 * lead_ + 0.1 * lead;
    double dev = lead_ - leadTarget_;
    shiftSyms_++;
    if (std::fabs(dev) >= 1.0) {
      int s = (int)std::lround(dev);
      if (s > N_ / 16) s = N_ / 16; if (s < -N_ / 16) s = -N_ / 16;
      win_ += s; lead_ -= s; shiftSum_ += s;
      // phases of everything stored shift with the window
      const T1Tab &tb = *tb_;
      for (int g = 0; g < (int)Hg_.size(); g++) { double a = 2 * PI * 3.0 * g * s / N_; Hg_[g] *= cf((float)cos(a), (float)sin(a)); }
      for (int k = 0; k <= tb.K; k++) { double a = 2 * PI * (double)k * s / N_; cf r((float)cos(a), (float)sin(a)); prev_[k] *= r; ring_[(ringN_ - 1) & 3][k] *= r; }
    }
    st.delay = lead_;
    if (shiftSyms_ > 50) st.sfoPpm = -1e6 * (double)shiftSum_ / ((double)shiftSyms_ * T_);
  }

  // ---------------------------------------------------------------- data path of one symbol
  void decodeSymbol(int lf) {
    const T1Tab &tb = *tb_;
    if (st.hier != 0) return;
    interpolate();
    int m = lf & 3;
    // noise estimate from the scattered pilots of this symbol against the neighbours of the grid
    {
      double e = 0, sg = 0; int n = 0;
      for (int k = 3 * m; k + 3 <= tb.K; k += 12) {
        int g = k / 3; if (g < 1) continue;
        cf mid = 0.5f * (Hg_[g - 1] + Hg_[g + 1]);
        cf d = Hg_[g] - mid; e += cabs2(d); sg += cabs2(Hg_[g]); n++;
      }
      if (n > 4 && e > 0) {
        double snr = 10 * std::log10(std::max(1e-3, sg / std::max(1e-12, (e / 1.5))));
        if (snr > 60) snr = 60;
        snrAvg_ = snrInit_ ? 0.95 * snrAvg_ + 0.05 * snr : snr; snrInit_ = true;
        st.snrDb = snrAvg_;
      }
    }
    const std::vector<int> &dk = tb.data[m];
    int nd = (int)dk.size();
    int v = cs_.v, bpa = v / 2;
    // equalise, demap
    static std::vector<float> soft; soft.assign((size_t)nd * v, 0.f);
    float li[3], lq[3];
    for (int i = 0; i < nd; i++) {
      int k = dk[i];
      cf h = Hall_[k]; float w = cabs2(h);
      if (w < 1e-12f) continue;
      cf z = yc_[k] * std::conj(h) / w;
      cs_.axisLlr(z.real(), cs_.lvlI, li);
      cs_.axisLlr(z.imag(), cs_.lvlQ, lq);
      float *o = &soft[(size_t)i * v];
      for (int t = 0; t < bpa; t++) { o[2 * t] = li[t] * w; o[2 * t + 1] = lq[t] * w; }
    }
    // symbol deinterleaver: even symbols tx out[H(q)] = in[q], odd symbols out[q] = in[H(q)]
    static std::vector<float> sd; sd.resize((size_t)nd * v);
    for (int q = 0; q < nd; q++) {
      const float *from; float *to;
      if (lf & 1) { from = &soft[(size_t)q * v]; to = &sd[(size_t)tb.H[q] * v]; }
      else { from = &soft[(size_t)tb.H[q] * v]; to = &sd[(size_t)q * v]; }
      for (int e = 0; e < v; e++) to[e] = from[e];
    }
    // bit deinterleaver, blocks of 126 cells
    static const int OFF[6] = {0, 63, 105, 42, 21, 84};
    static std::vector<float> bi; bi.resize((size_t)nd * v);
    float sub[6][126];
    for (int blk = 0; blk < nd / 126; blk++) {
      const float *in = &sd[(size_t)blk * 126 * v];
      for (int w = 0; w < 126; w++) for (int e = 0; e < v; e++) sub[e][(w + OFF[e]) % 126] = in[w * v + e];
      float *o = &bi[(size_t)blk * 126 * v];
      for (int i = 0; i < 126; i++) for (int k = 0; k < v; k++) {
        int e = (k / (v / 2)) + 2 * (k % (v / 2));
        o[i * v + k] = sub[e][i];
      }
    }
    // quantise
    double mean = 0; for (size_t i = 0; i < bi.size(); i++) mean += fabsf(bi[i]); mean /= (double)bi.size();
    float g = mean > 1e-12 ? (float)(24.0 / mean) : 1.f;
    coded_.resize(bi.size());
    for (size_t i = 0; i < bi.size(); i++) { float q = bi[i] * g; q = q > 127 ? 127 : q < -127 ? -127 : q; coded_[i] = (int8_t)lrintf(q); }
    pairs_.clear();
    pun_.depuncture(coded_.data(), coded_.size(), pairs_);
    vbits_.clear();
    vit_.push(pairs_.data(), pairs_.size() / 2, vbits_);
    if (!vbits_.empty()) tsd_.push(vbits_.data(), vbits_.size(), tsOut_);
  }
};

}  // namespace dvbofdm
