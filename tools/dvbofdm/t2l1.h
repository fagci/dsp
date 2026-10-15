// DVB-T2 L1 signalling: L1-pre and L1-post decoding (EN 302 755 §7) and field parsing.
#pragma once
#include "common.h"
#include "ldpc.h"
#include "ldpc_gen.h"
#include "l1_gen.h"
#include "bch.h"
#include <cstdio>
#include <cstdlib>

namespace dvbofdm {

struct L1Pre {
  bool ok = false;
  int type = 0, bwtExt = 0, s1 = 0, s2 = 0, rep = 0, gi = 0, papr = 0, l1mod = 0, l1cod = 0, l1fec = 0;
  int postSize = 0, postInfo = 0, pp = 0, txId = 0, cellId = 0, netId = 0, sysId = 0, nFrames = 0, nData = 0;
  int regen = 0, ext = 0, numRf = 0, curRf = 0, ver = 0, scrambled = 0, baseLite = 0;
};

struct PlpCfg {
  int id = 0, type = 0, payload = 0, ff = 0, firstRf = 0, firstFrame = 0, group = 0, cod = 0, mod = 0, rot = 0, fec = 0;
  int blocksMax = 0, frameInterval = 0, tilLen = 0, tilType = 0, inbandA = 0, inbandB = 0, mode = 0, staticFlag = 0, staticPad = 0;
  // dynamic part of the current frame
  int start = 0, blocks = 0;
};

struct L1Post {
  bool ok = false;
  int subSlices = 0, numPlp = 0, numAux = 0;
  int frameIdx = 0, subSliceInterval = 0, type2Start = 0, changeCounter = 0;
  std::vector<PlpCfg> plp;
};

inline uint32_t crc32msb(const uint8_t *b, int n) {
  uint32_t crc = 0xffffffff;
  for (int i = 0; i < n; i++) { int t = b[i] ^ ((crc >> 31) & 1); crc <<= 1; if (t) crc ^= 0x04C11DB7; }
  return crc;
}

struct BitReader {
  const uint8_t *b; int pos = 0;
  explicit BitReader(const uint8_t *p) : b(p) {}
  int get(int n) { int v = 0; for (int i = 0; i < n; i++) v = (v << 1) | b[pos++]; return v; }
};

class L1Decoder {
 public:
  L1Decoder() {
    pre_.build(16200, 3240, &LDPC_T2_1_4S[0][0], 9, 13);
    post_.build(16200, 7200, &LDPC_T2_1_2S[0][0], 20, 9);
    bchPre_.init(true, 12, 3072);
    bchPost_.init(true, 12, 7032);
  }

  // cells: the 1840 L1-pre cells (BPSK), w: |H|^2 per cell
  bool decodePre(const cf *cell, const float *w, L1Pre &o) {
    std::vector<float> llr(16200, 0.f);
    for (int i = 0; i < 200; i++) llr[i] = cell[i].real() * w[i] * 4;
    for (int i = 200; i < 3072; i++) llr[i] = 40.f;
    for (int i = 0; i < 168; i++) llr[3072 + i] = cell[200 + i].real() * w[200 + i] * 4;
    std::vector<uint8_t> punct(12960, 0);
    for (int c = 0; c < 31; c++) for (int c2 = 0; c2 < 360; c2++) punct[c2 * 36 + L1_pre_puncture[c]] = 1;
    for (int c2 = 0; c2 < 328; c2++) punct[c2 * 36 + L1_pre_puncture[31]] = 1;
    int k = 368;
    for (int i = 0; i < 12960; i++) if (!punct[i]) { llr[3240 + i] = cell[k].real() * w[k] * 4; k++; }
    std::vector<uint8_t> bits(16200);
    pre_.decode(llr.data(), bits.data(), 60);
    bchPre_.decode(bits.data());
    if (crc32msb(bits.data(), 200) != 0) return false;
    BitReader r(bits.data());
    o.type = r.get(8); o.bwtExt = r.get(1); o.s1 = r.get(3); o.s2 = r.get(3) << 1; o.s2 |= r.get(1);
    o.rep = r.get(1); o.gi = r.get(3); o.papr = r.get(4); o.l1mod = r.get(4); o.l1cod = r.get(2); o.l1fec = r.get(2);
    o.postSize = r.get(18); o.postInfo = r.get(18); o.pp = r.get(4); o.txId = r.get(8); o.cellId = r.get(16);
    o.netId = r.get(16); o.sysId = r.get(16); o.nFrames = r.get(8); o.nData = r.get(12); o.regen = r.get(3);
    o.ext = r.get(1); o.numRf = r.get(3); o.curRf = r.get(3); o.ver = r.get(4); o.scrambled = r.get(1);
    o.baseLite = r.get(1);
    o.ok = true;
    return true;
  }

  // post cells: postSize cells (modulation per L1-pre), weights; s2 low bit tells whether FEF fields exist
  bool decodePost(const L1Pre &pre, const cf *cell, const float *w, L1Post &o) {
    int etaMod = pre.l1mod == 0 ? 1 : pre.l1mod == 1 ? 2 : pre.l1mod == 2 ? 4 : 6;
    int ksig = pre.postInfo + 32;
    int npost = pre.postSize * etaMod;
    int npuncT = (6 * (7032 - ksig)) / 5;
    int npostT = ksig + 168 + 9000 - npuncT;
    int npunc = npuncT - (npost - npostT);
    if (ksig > 7032 || npunc < 0) return false;
    // soft bits of the transmitted sequence l1_interleave[0..npost)
    std::vector<float> sb(npost, 0.f);
    demapL1(pre.l1mod, cell, w, pre.postSize, sb.data(), npost);
    // un-interleave (16QAM / 64QAM)
    std::vector<float> seq(npost);
    if (pre.l1mod == 2 || pre.l1mod == 3) {
      int numCols = pre.l1mod == 2 ? 8 : 12, rows = npost / numCols;
      // TX: columns of l1_interleave are read row by row into the symbol stream
      for (int k = 0; k < rows; k++) for (int c = 0; c < numCols; c++) seq[(size_t)rows * c + k] = sb[(size_t)k * numCols + c];
    } else seq = sb;
    // padding map
    const int *padTab = pre.l1mod == 2 ? L1_post_padding_16qam : pre.l1mod == 3 ? L1_post_padding_64qam : L1_post_padding_bqpsk;
    const int *punTab = pre.l1mod == 2 ? L1_post_puncture_16qam : pre.l1mod == 3 ? L1_post_puncture_64qam : L1_post_puncture_bqpsk;
    std::vector<uint8_t> pad(7032, 0);
    int m, last;
    if (ksig <= 360) { m = 19; last = 360 - ksig; } else { m = (7032 - ksig) / 360; last = 7032 - ksig - 360 * m; }
    for (int n = 0; n < m; n++) {
      int idx = padTab[n] * 360;
      int cnt = padTab[n] == 19 ? 192 : 360;
      for (int w2 = 0; w2 < cnt; w2++) pad[idx++] = 1;
    }
    {
      int idx = padTab[m] == 19 ? padTab[m] * 360 + 192 - last : padTab[m] * 360 + 360 - last;
      for (int w2 = 0; w2 < last; w2++) pad[idx++] = 1;
    }
    std::vector<uint8_t> punct(9000, 0);
    for (int c = 0; c < npunc / 360; c++) for (int c2 = 0; c2 < 360; c2++) punct[c2 * 25 + punTab[c]] = 1;
    for (int c2 = 0; c2 < npunc - (npunc / 360) * 360; c2++) punct[c2 * 25 + punTab[npunc / 360]] = 1;
    std::vector<float> llr(16200, 0.f);
    int idx = 0;
    for (int i = 0; i < 7032; i++) llr[i] = pad[i] ? 40.f : seq[idx++];
    for (int i = 0; i < 168; i++) llr[7032 + i] = seq[idx++];
    for (int i = 0; i < 9000; i++) if (!punct[i]) llr[7200 + i] = seq[idx++];
    if (idx != npost) return false;
    std::vector<uint8_t> bits(16200);
    int itp = 0; bool lok = post_.decode(llr.data(), bits.data(), 60, &itp);
    int bfix = bchPost_.decode(bits.data());
    if (getenv("T2DBG")) fprintf(stderr, "L1-post: ldpc ok %d iters %d bch fixed %d ksig %d npost %d npunc %d\n", lok, itp, bfix, ksig, npost, npunc);
    std::vector<uint8_t> info; info.reserve(ksig);
    for (int i = 0; i < 7032 && (int)info.size() < ksig; i++) if (!pad[i]) info.push_back(bits[i]);
    if ((int)info.size() != ksig) return false;
    if (pre.scrambled) {
      int sr = 0x4A80;
      for (int i = 0; i < ksig; i++) { int b = ((sr) ^ (sr >> 1)) & 1; info[i] ^= b; sr >>= 1; if (b) sr |= 0x4000; }
    }
    if (getenv("T2DBG")) fprintf(stderr, "L1-post crc residue %08x scrambled %d ver %d\n", crc32msb(info.data(), ksig), pre.scrambled, pre.ver);
    if (crc32msb(info.data(), ksig) != 0) return false;
    return parsePost(pre, info.data(), ksig - 32, o);
  }

 private:
  LdpcCode pre_, post_; Bch bchPre_, bchPost_;

  static void demapL1(int mod, const cf *cell, const float *w, int ncell, float *out, int nbits) {
    if (mod == 0) { for (int i = 0; i < ncell; i++) out[i] = cell[i].real() * w[i] * 4; return; }
    if (mod == 1) {
      for (int i = 0; i < ncell; i++) {
        out[2 * i] = cell[i].real() * w[i] * 4 * 0.7071f;
        out[2 * i + 1] = cell[i].imag() * w[i] * 4 * 0.7071f;
      }
      return;
    }
    // 16QAM / 64QAM: cells carry the muxed bits (see l1_gen.h mux tables); pairs of cells make a group of 2m bits
    int bpc = mod == 2 ? 4 : 6;
    int gb = 2 * bpc;
    const int *mux = mod == 2 ? L1_mux16 : L1_mux64;
    static const double L16[4] = {3, 1, -3, -1};
    static const double L64[8] = {7, 5, 1, 3, -7, -5, -1, -3};
    double nrm = mod == 2 ? sqrt(10.0) : sqrt(42.0);
    int L = bpc / 2, nl = 1 << L;
    std::vector<float> lev(nl);
    for (int a = 0; a < nl; a++) lev[a] = (float)((mod == 2 ? L16[a] : L64[a]) / nrm);
    for (int g = 0; g < ncell / 2; g++) {
      float lc[2][8];
      for (int c = 0; c < 2; c++) {
        const cf &z = cell[2 * g + c]; float ww = w[2 * g + c];
        for (int ax = 0; ax < 2; ax++) {
          float x = ax == 0 ? z.real() : z.imag();
          float d0[4], d1[4];
          for (int j = 0; j < L; j++) d0[j] = d1[j] = 1e30f;
          for (int a = 0; a < nl; a++) {
            float dd = (x - lev[a]); dd = dd * dd * ww;
            for (int j = 0; j < L; j++) { if ((a >> (L - 1 - j)) & 1) { if (dd < d1[j]) d1[j] = dd; } else if (dd < d0[j]) d0[j] = dd; }
          }
          for (int j = 0; j < L; j++) lc[c][2 * j + ax] = (d1[j] - d0[j]) * 4;
        }
      }
      // TX: pack bit e (0..gb-1) of the group is taken from l1_temp[index + mux[e]]... place LLRs back
      // pack = sum of bit(index+offset) << (gb-1-e'), where offset = mux[e]; cell0 = pack >> bpc, cell1 = pack & mask
      // so label bit position p (from LSB) of the pack came from stream bit index + mux[e] with gb-1-e = p ... see below
      for (int e = 0; e < gb; e++) {
        int offset = mux[e];
        // loop in TX: for e: pack |= bit[index + offset] ; pack <<= 1  (then >>= 1 at the end): bit e ends at position gb-1-e
        int p = gb - 1 - e;
        int cell0 = p >= bpc ? 0 : 1;
        int pc = p >= bpc ? p - bpc : p;
        int k = bpc - 1 - pc;
        out[g * gb + offset] = lc[cell0][k];
      }
    }
  }

  static bool parsePost(const L1Pre &pre, const uint8_t *b, int n, L1Post &o) {
    BitReader r(b);
    auto need = [&](int bits) { return r.pos + bits <= n; };
    if (!need(35)) return false;
    o.subSlices = r.get(15); o.numPlp = r.get(8); o.numAux = r.get(4); r.get(8);
    int numRf = pre.numRf ? pre.numRf : 1;
    if (!need(35 * numRf)) return false;
    for (int i = 0; i < numRf; i++) { r.get(3); r.get(32); }
    if (pre.s2 & 1) { if (!need(34)) return false; r.get(4); r.get(22); r.get(8); }
    o.plp.assign(o.numPlp, PlpCfg());
    if (!need(89 * o.numPlp + 32)) return false;
    for (int i = 0; i < o.numPlp; i++) {
      PlpCfg &p = o.plp[i];
      p.id = r.get(8); p.type = r.get(3); p.payload = r.get(5); p.ff = r.get(1); p.firstRf = r.get(3); p.firstFrame = r.get(8);
      p.group = r.get(8); p.cod = r.get(3); p.mod = r.get(3); p.rot = r.get(1); p.fec = r.get(2); p.blocksMax = r.get(10);
      p.frameInterval = r.get(8); p.tilLen = r.get(8); p.tilType = r.get(1); p.inbandA = r.get(1); p.inbandB = r.get(1);
      r.get(11); p.mode = r.get(2); p.staticFlag = r.get(1); p.staticPad = r.get(1);
    }
    r.get(2); r.get(30);
    if (!need(32 * o.numAux)) return false;
    for (int i = 0; i < o.numAux; i++) { r.get(4); r.get(28); }
    if (!need(71 + 48 * o.numPlp + 8)) return false;
    o.frameIdx = r.get(8); o.subSliceInterval = r.get(22); o.type2Start = r.get(22); o.changeCounter = r.get(8); r.get(3); r.get(8);
    for (int i = 0; i < o.numPlp; i++) {
      int id = r.get(8); int st = r.get(22); int nb = r.get(10); r.get(8);
      for (auto &p : o.plp) if (p.id == id) { p.start = st; p.blocks = nb; }
    }
    o.ok = true;
    return true;
  }
};

}  // namespace dvbofdm
