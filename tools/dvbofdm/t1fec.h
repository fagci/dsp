// DVB-T (EN 300 744) outer / inner decoding: depuncturing, Viterbi, byte sync, convolutional deinterleaver, Reed-Solomon, descrambler.
#pragma once
#include "common.h"

namespace dvbofdm {

// Rate 1/2, K=7 (171, 133 octal) streaming soft-decision Viterbi decoder. Input: pairs (x, y) of int8 (llr > 0 means bit 0, 0 = erased).
class T1Viterbi {
 public:
  static const int D = 128;                    // traceback depth (bits); long enough for 7/8
  T1Viterbi() {
    for (int r = 0; r < 128; r++) { xo_[r] = par(r & 0x79); yo_[r] = par(r & 0x5B); }
    reset();
  }
  void reset() { memset(pm_, 0, sizeof pm_); dec_.clear(); steps_ = 0; }
  // Decodes n input bits (n pairs) and appends the bits that are at least D steps old.
  void push(const int8_t *p, size_t n, std::vector<uint8_t> &out) {
    uint8_t c0[32], c1[32], c2[32], c3[32];       // output-pair index of the four branches of each butterfly
    for (int j = 0; j < 32; j++) {
      c0[j] = xo_[2 * j] << 1 | yo_[2 * j];
      c1[j] = xo_[2 * j + 1] << 1 | yo_[2 * j + 1];
      c2[j] = xo_[64 | 2 * j] << 1 | yo_[64 | 2 * j];
      c3[j] = xo_[64 | 2 * j + 1] << 1 | yo_[64 | 2 * j + 1];
    }
    int16_t npm[64];
    for (size_t t = 0; t < n; t++) {
      int l0 = p[2 * t], l1 = p[2 * t + 1];
      int16_t bm[4] = {(int16_t)(l0 + l1), (int16_t)(l0 - l1), (int16_t)(-l0 + l1), (int16_t)(-l0 - l1)};
      uint64_t d = 0;
      for (int j = 0; j < 32; j++) {
        int a0 = pm_[2 * j] + bm[c0[j]], a1 = pm_[2 * j + 1] + bm[c1[j]];
        int b0 = pm_[2 * j] + bm[c2[j]], b1 = pm_[2 * j + 1] + bm[c3[j]];
        npm[j] = (int16_t)(a1 > a0 ? a1 : a0);
        npm[j + 32] = (int16_t)(b1 > b0 ? b1 : b0);
        d |= (uint64_t)(a1 > a0) << j;
        d |= (uint64_t)(b1 > b0) << (j + 32);
      }
      dec_.push_back(d);
      memcpy(pm_, npm, sizeof pm_);
      if ((++steps_ & 15) == 0) {
        int mx = pm_[0]; for (int s = 1; s < 64; s++) mx = std::max<int>(mx, pm_[s]);
        for (int s = 0; s < 64; s++) pm_[s] = (int16_t)(pm_[s] - mx);
      }
    }
    if (dec_.size() <= (size_t)D) return;
    size_t emit = dec_.size() - D;
    int best = 0; for (int s = 1; s < 64; s++) if (pm_[s] > pm_[best]) best = s;
    tmp_.resize(dec_.size());
    int s = best;
    for (size_t t = dec_.size(); t-- > 0;) {
      tmp_[t] = (uint8_t)(s >> 5);
      s = ((s & 31) << 1) | (int)((dec_[t] >> s) & 1);
    }
    out.insert(out.end(), tmp_.begin(), tmp_.begin() + emit);
    dec_.erase(dec_.begin(), dec_.begin() + emit);
  }

 private:
  static uint8_t par(int v) { v ^= v >> 4; v ^= v >> 2; v ^= v >> 1; return (uint8_t)(v & 1); }
  uint8_t xo_[128], yo_[128];
  int16_t pm_[64];
  std::vector<uint64_t> dec_;
  std::vector<uint8_t> tmp_;
  uint32_t steps_ = 0;
};

// Puncturing: coded bits per cycle and which of X / Y they are (index of the input bit inside the cycle, 0 = X, 1 = Y)
struct T1Punct {
  int k = 1, n = 2;
  int step[8], which[8];
  // rate index 0..4 = 1/2 2/3 3/4 5/6 7/8
  bool init(int rate) {
    static const int K[5] = {1, 2, 3, 5, 7}, Nn[5] = {2, 3, 4, 6, 8};
    static const int ST[5][8] = {{0, 0}, {0, 0, 1}, {0, 0, 1, 2}, {0, 0, 1, 2, 3, 4}, {0, 0, 1, 2, 3, 4, 5, 6}};
    static const int WH[5][8] = {{0, 1}, {0, 1, 1}, {0, 1, 1, 0}, {0, 1, 1, 0, 1, 0}, {0, 1, 1, 1, 1, 0, 1, 0}};
    if (rate < 0 || rate > 4) return false;
    k = K[rate]; n = Nn[rate];
    for (int i = 0; i < n; i++) { step[i] = ST[rate][i]; which[i] = WH[rate][i]; }
    return true;
  }
  // Spreads soft coded bits (a whole number of cycles) into pairs for the Viterbi decoder
  void depuncture(const int8_t *in, size_t cnt, std::vector<int8_t> &pairs) const {
    size_t cycles = cnt / n;
    size_t base = pairs.size();
    pairs.resize(base + cycles * k * 2, 0);
    for (size_t c = 0; c < cycles; c++) {
      int8_t *o = &pairs[base + c * k * 2];
      for (int i = 0; i < n; i++) o[step[i] * 2 + which[i]] = in[c * n + i];
    }
  }
};

// Reed-Solomon (204, 188, t = 8) over GF(256), primitive polynomial 0x11d, roots alpha^0 .. alpha^15
class T1Rs {
 public:
  T1Rs() {
    int x = 1;
    for (int i = 0; i < 255; i++) { exp_[i] = (uint8_t)x; log_[x] = (uint8_t)i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (int i = 255; i < 512; i++) exp_[i] = exp_[i - 255];
    log_[0] = 0;
  }
  // r: 204 bytes. Returns the number of corrected bytes or -1 when the block is uncorrectable.
  int decode(uint8_t *r) const {
    int S[16]; bool any = false;
    for (int i = 0; i < 16; i++) {
      int s = 0;
      for (int j = 0; j < 204; j++) s = mul(s, exp_[i]) ^ r[j];
      S[i] = s; if (s) any = true;
    }
    if (!any) return 0;
    int C[17] = {1}, B[17] = {1}, L = 0, m = 1, b = 1;
    for (int n = 0; n < 16; n++) {
      int d = S[n];
      for (int i = 1; i <= L; i++) d ^= mul(C[i], S[n - i]);
      if (d == 0) { m++; continue; }
      int T[17]; memcpy(T, C, sizeof T);
      int coef = div(d, b);
      for (int i = 0; i + m <= 16; i++) C[i + m] ^= mul(coef, B[i]);
      if (2 * L <= n) { L = n + 1 - L; memcpy(B, T, sizeof B); b = d; m = 1; } else m++;
    }
    if (L > 8) return -1;
    int pos[8], nr = 0;
    for (int j = 0; j < 204; j++) {                  // byte j has locator X = alpha^(203 - j); root of C at X^-1
      int e = (255 - (203 - j)) % 255, v = 0;
      for (int i = 0; i <= L; i++) v ^= mul(C[i], exp_[(e * i) % 255]);
      if (v == 0) { if (nr >= 8) return -1; pos[nr++] = j; }
    }
    if (nr != L) return -1;
    int Om[16];
    for (int i = 0; i < 16; i++) { int v = 0; for (int k = 0; k <= i && k <= L; k++) v ^= mul(C[k], S[i - k]); Om[i] = v; }
    for (int q = 0; q < nr; q++) {
      int j = pos[q], X = exp_[203 - j], Xi = exp_[(255 - (203 - j)) % 255];
      int num = 0, xp = 1;
      for (int i = 0; i < 16; i++) { num ^= mul(Om[i], xp); xp = mul(xp, Xi); }
      int den = 0; xp = 1;
      for (int i = 1; i <= L; i += 2) { den ^= mul(C[i], xp); xp = mul(xp, mul(Xi, Xi)); }
      if (den == 0) return -1;
      r[j] ^= (uint8_t)mul(X, div(num, den));
    }
    for (int i = 0; i < 16; i++) {                    // verify
      int s = 0; for (int j = 0; j < 204; j++) s = mul(s, exp_[i]) ^ r[j];
      if (s) return -1;
    }
    return nr;
  }

 private:
  uint8_t exp_[512], log_[256];
  int mul(int a, int b) const { return (a && b) ? exp_[log_[a] + log_[b]] : 0; }
  int div(int a, int b) const { return a ? exp_[log_[a] + 255 - log_[b]] : 0; }
};

// Bits from the Viterbi decoder -> byte sync (0x47 / 0xB8 every 204 bytes) -> deinterleaver (I = 12, M = 17) -> RS -> descrambler -> TS
class T1Ts {
 public:
  uint64_t packets = 0, rsFixed = 0, rsFail = 0, syncLoss = 0;
  bool synced = false;

  void reset() {
    bits_.clear(); synced = false; miss_ = 0; filled_ = 0; idx_ = 0; haveIdx_ = false;
    for (int j = 0; j < 12; j++) { fifo_[j].assign((size_t)(11 - j) * 17, 0); head_[j] = 0; }
  }
  T1Ts() { reset(); }

  void push(const uint8_t *bits, size_t n, std::vector<uint8_t> &ts) {
    bits_.insert(bits_.end(), bits, bits + n);
    if (!synced) {
      const size_t P = 204 * 8, need = P * 10;
      if (bits_.size() < need) return;
      int bestHits = 0; size_t bestOff = 0;
      for (size_t o = 0; o < P; o++) {
        int hits = 0;
        for (int p = 0; p < 9; p++) {
          int v = 0; const uint8_t *b = &bits_[o + P * p];
          for (int i = 0; i < 8; i++) v = (v << 1) | b[i];
          if (v == 0x47 || v == 0xB8) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestOff = o; }
      }
      if (bestHits < 8) { bits_.erase(bits_.begin(), bits_.begin() + (bits_.size() - P * 2)); return; }
      bits_.erase(bits_.begin(), bits_.begin() + bestOff);
      synced = true; miss_ = 0; filled_ = 0; haveIdx_ = false;
      for (int j = 0; j < 12; j++) { fifo_[j].assign((size_t)(11 - j) * 17, 0); head_[j] = 0; }
    }
    size_t used = 0;
    uint8_t pk[204], out[204];
    while (bits_.size() - used >= 204 * 8) {
      const uint8_t *b = &bits_[used];
      for (int i = 0; i < 204; i++) { int v = 0; for (int k = 0; k < 8; k++) v = (v << 1) | b[i * 8 + k]; pk[i] = (uint8_t)v; }
      used += 204 * 8;
      if (pk[0] == 0x47 || pk[0] == 0xB8) miss_ = 0;
      else if (++miss_ > 12) { synced = false; syncLoss++; used = 0; bits_.clear(); return; }
      for (int i = 0; i < 204; i++) {                  // deinterleave: byte i goes through branch i % 12
        int j = i % 12; size_t L = fifo_[j].size();
        if (!L) { out[i] = pk[i]; continue; }
        out[i] = fifo_[j][head_[j]]; fifo_[j][head_[j]] = pk[i]; head_[j] = (head_[j] + 1) % L;
      }
      if (filled_ < 11) { filled_++; continue; }       // the first 11 packets are the empty delay lines
      int rc = rs_.decode(out);
      if (rc < 0) {
        rsFail++;
        if (haveIdx_) { advance(out, false, ts); }
        continue;
      }
      rsFixed += rc;
      if (out[0] == 0xB8) { idx_ = 0; haveIdx_ = true; }
      if (haveIdx_) advance(out, true, ts);
    }
    bits_.erase(bits_.begin(), bits_.begin() + used);
  }

 private:
  std::vector<uint8_t> bits_;
  std::vector<uint8_t> fifo_[12]; size_t head_[12];
  T1Rs rs_;
  int miss_ = 0, filled_ = 0, idx_ = 0; bool haveIdx_ = false;
  uint32_t prbs_ = 0xA9;

  // One packet in sequence (idx_ counts the 8 packet groups); the PRBS keeps running over the sync byte of packets 1..7
  void advance(const uint8_t *pk, bool good, std::vector<uint8_t> &ts) {
    if (idx_ == 0) prbs_ = 0xA9;
    uint8_t o[188];
    o[0] = 0x47;
    for (int i = 1; i < 188; i++) { o[i] = pk[i] ^ clock8(); }
    clock8();
    idx_ = (idx_ + 1) & 7;
    if (good) { ts.insert(ts.end(), o, o + 188); packets++; }
  }
  uint8_t clock8() {
    int res = 0;
    for (int i = 0; i < 8; i++) {
      int fb = ((prbs_ >> 13) ^ (prbs_ >> 14)) & 1;
      prbs_ = ((prbs_ << 1) | fb) & 0x7fff;
      res = (res << 1) | fb;
    }
    return (uint8_t)res;
  }
};

}  // namespace dvbofdm
