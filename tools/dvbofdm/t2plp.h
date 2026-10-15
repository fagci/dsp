// DVB-T2 PLP decoding: frame cell stream, PLP cell extraction, time / cell de-interleaving, FEC and BBFRAME -> TS.
#pragma once
#include "common.h"
#include "t2demod.h"
#include "t2fec.h"
#include <map>
#include <cstdio>
#include <cstdlib>

namespace dvbofdm {

// The cells of a frame in addressing order (after the L1 cells), see EN 302 755 §8.3 and the layout of the gr-dtv frame mapper
struct T2Stream {
  std::vector<cf> cell; std::vector<float> w;
};

inline void buildStream(const T2FrameCells &fc, const L1Pre &pre, T2Stream &s) {
  int NP = fc.nP2;
  int npc = pre.postSize;
  s.cell.clear(); s.w.clear();
  int skip = (1840 + npc) / NP;
  for (int p = 0; p < NP; p++) {
    const std::vector<cf> &c = fc.cell[p]; const std::vector<float> &w = fc.wgt[p];
    for (int j = skip; j < (int)c.size(); j++) { s.cell.push_back(c[j]); s.w.push_back(w[j]); }
  }
  int nsym = (int)fc.cell.size();
  for (int l = NP; l < nsym; l++) {
    bool fcSym = fc.nFc != 0 && l == nsym - 1;
    int use = fcSym ? fc.cFc : (int)fc.cell[l].size();
    const std::vector<cf> &c = fc.cell[l]; const std::vector<float> &w = fc.wgt[l];
    for (int j = 0; j < use && j < (int)c.size(); j++) { s.cell.push_back(c[j]); s.w.push_back(w[j]); }
  }
}

// Cell interleaver permutation and the shift sequence (dvbt2_cellinterleaver)
struct CellPerm {
  int cellSize = 0, degree = 0;
  std::vector<int> perm;
  void init(bool shortFrame, int mod) {
    int maxStates, mask, xorSize; const int *logic;
    static const int l11[2] = {0, 3}, l12[2] = {0, 2}, l13[4] = {0, 1, 4, 6}, l14[6] = {0, 1, 4, 5, 9, 11}, l15[4] = {0, 1, 2, 12};
    if (!shortFrame) {
      switch (mod) {
        case 0: cellSize = 32400; degree = 15; mask = 0x3fff; maxStates = 32768; logic = l15; xorSize = 4; break;
        case 1: cellSize = 16200; degree = 14; mask = 0x1fff; maxStates = 16384; logic = l14; xorSize = 6; break;
        case 2: cellSize = 10800; degree = 14; mask = 0x1fff; maxStates = 16384; logic = l14; xorSize = 6; break;
        default: cellSize = 8100; degree = 13; mask = 0xfff; maxStates = 8192; logic = l13; xorSize = 4; break;
      }
    } else {
      switch (mod) {
        case 0: cellSize = 8100; degree = 13; mask = 0xfff; maxStates = 8192; logic = l13; xorSize = 4; break;
        case 1: cellSize = 4050; degree = 12; mask = 0x7ff; maxStates = 4096; logic = l12; xorSize = 2; break;
        case 2: cellSize = 2700; degree = 12; mask = 0x7ff; maxStates = 4096; logic = l12; xorSize = 2; break;
        default: cellSize = 2025; degree = 11; mask = 0x3ff; maxStates = 2048; logic = l11; xorSize = 2; break;
      }
    }
    perm.clear(); perm.reserve(cellSize);
    int lfsr = 0;
    for (int i = 0; i < maxStates; i++) {
      if (i == 0 || i == 1) lfsr = 0;
      else if (i == 2) lfsr = 1;
      else {
        int result = 0;
        for (int k = 0; k < xorSize; k++) result ^= (lfsr >> logic[k]) & 1;
        lfsr &= mask; lfsr >>= 1; lfsr |= result << (degree - 2);
      }
      lfsr |= (i % 2) << (degree - 1);
      if (lfsr < cellSize) perm.push_back(lfsr);
    }
  }
  // shift for block counter n (advances n like the transmitter does)
  int nextShift(int &n) const {
    int shift = cellSize;
    while (shift >= cellSize) {
      int temp = n; shift = 0;
      for (int p = 0; p < degree; p++) { shift |= temp & 1; shift <<= 1; temp >>= 1; }
      n++;
    }
    return shift;
  }
};

struct PlpStats { int blocks = 0, ok = 0, fixed = 0, bchFail = 0, iters = 0; };

// Unpacks BBFRAMEs of one PLP into 188 byte TS packets
class BbToTs {
 public:
  std::vector<uint8_t> part;   // incomplete unit carried over
  int mode = 0;                // 1 NM, 2 HEM, 0 unknown
  int issyi = 0, npd = 0;
  uint64_t frames = 0, crcBad = 0, packets = 0;

  static int crc8bits(const uint8_t *bits, int n) {  // as the transmitter: reflected 0xAB, bits as given
    int crc = 0;
    for (int i = 0; i < n; i++) { int b = bits[i] ^ (crc & 1); crc >>= 1; if (b) crc ^= 0xAB; }
    return crc;
  }

  // bits: kbch bits after BCH decoding (first 80 are the header). Returns false when the header is invalid.
  bool process(uint8_t *bits, int kbch, std::vector<uint8_t> &ts) {
    // descramble
    int sr = 0x4A80;
    for (int i = 0; i < kbch; i++) { int b = ((sr) ^ (sr >> 1)) & 1; bits[i] ^= b; sr >>= 1; if (b) sr |= 0x4000; }
    int crc = crc8bits(bits, 72);
    int rx = 0; for (int n = 0; n < 8; n++) rx |= bits[72 + n] << n;   // transmitter wrote bit n of the CRC at position n
    int hem;
    if (rx == crc) hem = 0; else if (rx == (crc ^ 0x80)) hem = 1; else { crcBad++; return false; }
    mode = hem ? 2 : 1;
    auto get = [&](int a, int n) { int v = 0; for (int i = 0; i < n; i++) v = (v << 1) | bits[a + i]; return v; };
    int tsgs = get(0, 2);
    issyi = bits[4]; npd = bits[5];
    // layout: MATYPE1(8) MATYPE2(8) UPL(16) DFL(16) SYNC(8) SYNCD(16) CRC(8)
    int dfl = get(32, 16), syncd = get(56, 16);
    if (getenv("T2DBG2") && frames < 6) fprintf(stderr, "bbframe hem %d tsgs %d issyi %d npd %d dfl %d syncd %d (%d bytes) part %zu\n", hem, tsgs, (int)bits[4], (int)bits[5], dfl, syncd, syncd / 8, part.size());
    if (tsgs != 3 || dfl <= 0 || dfl > kbch - 80) return false;
    std::vector<uint8_t> d(dfl / 8);
    for (size_t i = 0; i < d.size(); i++) d[i] = (uint8_t)get(80 + (int)i * 8, 8);
    frames++;
    int unit = hem ? 187 + (issyi ? 2 : 0) + (npd ? 1 : 0) : 188;
    int ps = syncd / 8;
    size_t i = 0;
    if (!part.empty()) {
      // complete the carried-over unit
      if (ps == 0xFFFF / 8 || (int)part.size() + ps != unit) {
        if (syncd == 0xFFFF) { part.insert(part.end(), d.begin(), d.end()); if ((int)part.size() >= unit) { emit(part.data(), hem, ts); part.erase(part.begin(), part.begin() + unit); } return true; }
        part.clear();
      } else {
        part.insert(part.end(), d.begin(), d.begin() + ps);
        emit(part.data(), hem, ts); part.clear(); i = ps;
      }
    }
    if (syncd == 0xFFFF) { part.insert(part.end(), d.begin(), d.end()); return true; }
    if (part.empty()) i = ps;
    for (; i + unit <= d.size(); i += unit) emit(&d[i], hem, ts);
    if (i < d.size()) part.assign(d.begin() + i, d.end());
    return true;
  }

 private:
  void emit(const uint8_t *u, int hem, std::vector<uint8_t> &ts) {
    if (hem) {
      if (npd) {
        int dnp = u[187 + (issyi ? 2 : 0)];
        for (int k = 0; k < dnp; k++) pushNull(ts);
      }
      ts.push_back(0x47); ts.insert(ts.end(), u, u + 187);
    } else {
      ts.push_back(0x47); ts.insert(ts.end(), u + 1, u + 188);
    }
    packets++;
  }
  static void pushNull(std::vector<uint8_t> &ts) {
    ts.push_back(0x47); ts.push_back(0x1F); ts.push_back(0xFF); ts.push_back(0x10);
    for (int i = 0; i < 184; i++) ts.push_back(0xFF);
  }
};

class PlpDecoder {
 public:
  PlpCfg cfg;
  T2Fec fec; CellPerm cp; BbToTs bb;
  int key = -1;
  bool bigFirst = false;
  int maxIter = 40;
  int streak = 0, idle = 0;   // consecutive failed FEC blocks; blocks skipped since
  bool lowSnr = false;        // the measured SNR is far below what the mode needs: only probe blocks are decoded
  PlpStats st;
  std::vector<std::vector<uint8_t>> *sink = nullptr;   // pool worker: decoded BBFRAMEs (bit-packed) are collected here instead of being turned into TS

  bool configure(const PlpCfg &c) {
    cfg = c;
    int k = (c.fec & 3) | (c.cod << 2) | (c.mod << 5) | (c.rot << 8);
    if (k != key) {
      key = k;
      bool sf = (c.fec & 3) == 0;
      if (c.fec > 1 || c.cod > 5 || c.mod > 3) { key = -1; return false; }
      if (!fec.init(sf, c.cod, c.mod, c.rot != 0)) { key = -1; return false; }
      cp.init(sf, c.mod);
    }
    return true;
  }

  // Cells of one interleaving frame mapped to one T2 frame (blocks*cellSize). Appends TS bytes.
  void decodeFrame(const cf *cell, const float *w, int blocks, std::vector<uint8_t> &ts) {
    int T = cfg.tilLen;
    std::vector<int> sizes;
    if (T == 0) { for (int i = 0; i < blocks; i++) sizes.push_back(1); }
    else {
      int small = blocks / T, big = (blocks + T - 1) / T, nbig = blocks % T, nsmall = T - nbig;
      if (bigFirst) { for (int i = 0; i < nbig; i++) sizes.push_back(big); for (int i = 0; i < nsmall; i++) sizes.push_back(small); }
      else { for (int i = 0; i < nsmall; i++) sizes.push_back(small); for (int i = 0; i < nbig; i++) sizes.push_back(big); }
    }
    decodeSizes(cell, w, blocks, sizes, T != 0, ts);
  }
  // One time interleaver block of `blocks` FEC blocks (interleaving frame spread over several T2 frames)
  void decodeOneTi(const cf *cell, const float *w, int blocks, std::vector<uint8_t> &ts) {
    decodeSizes(cell, w, blocks, std::vector<int>(1, blocks), true, ts);
  }
  void decodeSizes(const cf *cell, const float *w, int blocks, const std::vector<int> &sizes, bool ti, std::vector<uint8_t> &ts) {
    if (key < 0 || blocks <= 0) return;
    const int cs = fec.ncell;
    int T = ti ? 1 : 0;
    size_t base = 0;
    std::vector<cf> blk(cs); std::vector<float> bw(cs);
    std::vector<uint8_t> bits(fec.kbch);
    // below the FEC threshold every block runs the decoder to the iteration limit and fails: after a run of failures only every 16th block is tried
    streak = lowSnr ? 8 : std::min(streak, 4);   // a new frame: a couple of blocks are enough to see whether the signal came back
    for (int F : sizes) {
      if (F == 0) continue;
      size_t tot = (size_t)F * cs;
      std::vector<cf> m(tot); std::vector<float> mww(tot);
      if (T != 0) {
        int rows = cs / 5, nc = 5 * F;
        for (int k = 0; k < rows; k++) for (int c = 0; c < nc; c++) { m[(size_t)rows * c + k] = cell[base + (size_t)k * nc + c]; mww[(size_t)rows * c + k] = w[base + (size_t)k * nc + c]; }
      } else { for (size_t i = 0; i < tot; i++) { m[i] = cell[base + i]; mww[i] = w[base + i]; } }
      int n = 0;
      for (int r = 0; r < F; r++) {
        int shift = cp.nextShift(n);
        for (int j = 0; j < cs; j++) { size_t src = (size_t)r * cs + ((cp.perm[j] + shift) % cs); blk[j] = m[src]; bw[j] = mww[src]; }
        int it = 0, fx = 0, ok = 0;
        if (streak < 8 || (++idle & 15) == 0) { ok = fec.decode(blk.data(), bw.data(), bits.data(), streak < 8 ? maxIter : 12, &it, &fx); streak = ok ? 0 : streak + 1; }
        st.blocks++; st.iters += it;
        if (ok) { st.ok++; if (fx > 0) st.fixed++; } else st.bchFail++;
        if (ok) {
          if (sink) {
            std::vector<uint8_t> pk((fec.kbch + 7) / 8, 0);
            for (int i = 0; i < fec.kbch; i++) if (bits[i]) pk[i >> 3] |= 0x80 >> (i & 7);
            sink->push_back(std::move(pk));
          } else bb.process(bits.data(), fec.kbch, ts);
        }
      }
      base += tot;
    }
  }
};

}  // namespace dvbofdm
