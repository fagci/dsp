// Selection and decoding of the PLPs of a T2 frame: type 1 (one slice), type 2 (sub-slices), common PLP merge, interleaving
// frames spread over several T2 frames (TIME_IL_TYPE 1).
#pragma once
#include "t2plp.h"
#include <map>

namespace dvbofdm {

struct PlpRun {
  PlpDecoder dec;
  std::vector<cf> ifCell; std::vector<float> ifW; int ifFrames = 0, ifBlocks = 0, ifLast = -1;
  std::vector<uint8_t> out;            // decoded TS of this PLP (drained by the owner)
  int idleBad = 0; bool swapped = false;
};

class PlpSet {
 public:
  std::map<int, PlpRun> run;
  bool mergeCommon = true;
  // pool worker mode: decoded blocks are kept per PLP (see PlpDecoder::sink), `last` holds the counts of the latest frame() call
  bool capture = false, needSerial = false;
  std::map<int, std::vector<std::vector<uint8_t>>> blocks;
  std::map<int, std::pair<int, int>> last;

  // Cells of a PLP within the frame stream; false when it does not fit
  static bool gather(const PlpCfg &p, int cellsPerBlock, int blocks, const L1Post &post, const T2Stream &str, std::vector<cf> &c, std::vector<float> &w) {
    size_t total = (size_t)blocks * cellsPerBlock;
    c.clear(); w.clear();
    if (p.type == 2 && post.subSlices > 0) {
      size_t L = total / post.subSlices;
      if (L * post.subSlices != total) return false;
      for (int j = 0; j < post.subSlices; j++) {
        size_t a = (size_t)post.type2Start + p.start + (size_t)j * post.subSliceInterval;
        if (a + L > str.cell.size()) return false;
        c.insert(c.end(), str.cell.begin() + a, str.cell.begin() + a + L);
        w.insert(w.end(), str.w.begin() + a, str.w.begin() + a + L);
      }
      return true;
    }
    if ((size_t)p.start + total > str.cell.size()) return false;
    c.assign(str.cell.begin() + p.start, str.cell.begin() + p.start + total);
    w.assign(str.w.begin() + p.start, str.w.begin() + p.start + total);
    return true;
  }

  // Decodes PLP `p` of this frame; appends TS to run[p.id].out
  void frame(const PlpCfg &p, const L1Post &post, const T2Stream &str, PlpStats &acc, std::string &msg) {
    PlpRun &r = run[p.id];
    PlpDecoder &d = r.dec;
    d.maxIter = 50;
    d.fec.scale_ = 4.f; d.fec.beta = 0.f; d.fec.relBeta = 0.08f;
    if (!d.configure(p)) { msg = "unsupported PLP parameters"; return; }
    int interval = std::max(p.frameInterval, 1);
    int rel = post.frameIdx - p.firstFrame;
    if (rel < 0 || rel % interval) return;                    // the PLP is not in this frame
    int PI = p.tilType == 1 ? std::max(p.tilLen, 1) : 1;
    int pos = (rel / interval) % PI;
    if (p.blocks <= 0) return;
    if (capture && PI > 1) { needSerial = true; return; }     // a time interleaver over several frames needs the previous frames: not for independent workers
    d.sink = capture ? &blocks[p.id] : nullptr;
    std::vector<cf> c; std::vector<float> w;
    int before = d.st.blocks, okBefore = d.st.ok;
    if (PI == 1) {
      if (!gather(p, d.fec.ncell, p.blocks, post, str, c, w)) { msg = "PLP outside the frame"; return; }
      d.decodeFrame(c.data(), w.data(), p.blocks, r.out);
    } else {
      // an interleaving frame of p.blocks FEC blocks is spread over PI frames: the share of this frame
      size_t total = (size_t)p.blocks * d.fec.ncell, part = total / PI;
      size_t mine = pos == PI - 1 ? total - part * (PI - 1) : part;
      std::vector<cf> cc; std::vector<float> ww;
      PlpCfg q = p; q.blocks = 1;
      // gather `mine` cells starting at p.start (the share has this size in every frame of the interleaving frame)
      if ((size_t)p.start + mine > str.cell.size()) { msg = "PLP outside the frame"; return; }
      cc.assign(str.cell.begin() + p.start, str.cell.begin() + p.start + mine);
      ww.assign(str.w.begin() + p.start, str.w.begin() + p.start + mine);
      if (pos == 0) { r.ifCell.clear(); r.ifW.clear(); r.ifFrames = 0; r.ifBlocks = p.blocks; }
      if (r.ifFrames != pos) { r.ifFrames = -1; return; }          // missed the start of the interleaving frame: wait for the next one
      r.ifCell.insert(r.ifCell.end(), cc.begin(), cc.end()); r.ifW.insert(r.ifW.end(), ww.begin(), ww.end());
      r.ifFrames++;
      if (pos == PI - 1 && r.ifCell.size() == total) d.decodeOneTi(r.ifCell.data(), r.ifW.data(), r.ifBlocks, r.out);
    }
    int nb = d.st.blocks - before, no = d.st.ok - okBefore;
    acc.blocks += nb; acc.ok += no; acc.fixed += 0;
    last[p.id] = {nb, no};
    // none of a good number of blocks decoded: the other order of the time interleaver blocks may be the right one
    if (nb >= 8 && no == 0) { if (++r.idleBad >= 2) { d.bigFirst = !d.bigFirst; r.idleBad = 0; } } else if (no > 0) r.idleBad = 0;
  }

  // Replace the null packets of a data PLP stream by packets of its common PLP
  static void mergeCommonPackets(std::vector<uint8_t> &data, std::vector<uint8_t> &common) {
    size_t used = 0;
    for (size_t i = 0; i + 188 <= data.size() && used + 188 <= common.size(); i += 188) {
      if (data[i + 1] == 0x1F && data[i + 2] == 0xFF) { memcpy(&data[i], &common[used], 188); used += 188; }
    }
    common.erase(common.begin(), common.begin() + used);
  }
};

}  // namespace dvbofdm
