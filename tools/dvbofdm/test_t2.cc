// Development test: whole-frame demodulation of a DVB-T2 capture, L1-pre/L1-post, constellation quality.
#include "t2p1.h"
#include "t2demod.h"
#include "t2plp.h"
#include <cstdio>
using namespace dvbofdm;
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb");
  size_t total = argc > 2 ? atol(argv[2]) : 5000000;
  std::vector<cf> x(total + 64);
  size_t got = fread(x.data() + 64, 8, total, f); fclose(f);
  x.resize(got + 64);
  P1 p1; L1Decoder l1;
  float met; int64_t pos = p1.scan(x.data(), (int)std::min<size_t>(x.size(), 1 << 20), 0.3f, &met);
  P1Info pi = p1.identify(x.data(), (int)x.size(), (int)pos, met);
  printf("P1 at %lld s1 %d s2 %d cfo %.1f Hz\n", (long long)pos, pi.s1, pi.s2, pi.cfo * 9142857.0 / (2 * PI));
  int fftIdx = pi.s2 >> 1; bool miso = pi.s1 == 1 || pi.s1 == 4;
  int64_t p2 = pos + 2048;
  L1Pre pre; T2Setup S;
  bool found = false;
  for (int gi = 0; gi < 7 && !found; gi++) for (int ext = 0; ext < 2 && !found; ext++) {
    S.build(fftIdx, gi, ext, miso, 1, 0, 1, 0);
    T2FrameCells fc;
    if (!T2Demod::run(x, 0, S, p2, pi.cfo, S.N + S.G, S.G / 2, fc, true)) continue;
    std::vector<cf> c(1840); std::vector<float> w(1840);
    int NP = S.st->N_P2;
    for (int s = 0; s < NP; s++) for (int j = 0; j < 1840 / NP; j++) { c[s + j * NP] = fc.cell[s][j]; w[s + j * NP] = fc.wgt[s][j]; }
    if (l1.decodePre(c.data(), w.data(), pre)) { found = true; printf("L1-pre ok with gi %d ext %d: gi %d pp %d ndata %d post %d/%d mod %d\n", gi, ext, pre.gi, pre.pp, pre.nData, pre.postSize, pre.postInfo, pre.l1mod); }
  }
  if (!found) { printf("no L1-pre\n"); return 1; }
  S.build(fftIdx, pre.gi, pre.bwtExt, miso, pre.pp, pre.papr, pre.nData, pre.ver);
  T2FrameCells fc;
  bool ok = T2Demod::run(x, 0, S, p2, pi.cfo, S.N + S.G, S.G / 2, fc);
  printf("frame demod %d (symbols %d)\n", ok, S.st->num_symbols);
  if (!ok) return 1;
  // L1-post cells
  int NP = S.st->N_P2, npc = pre.postSize;
  std::vector<cf> pc(npc); std::vector<float> pw(npc);
  for (int u = 0; u < npc; u++) { int g = u; int s = g % NP, j = 1840 / NP + g / NP; pc[u] = fc.cell[s][j]; pw[u] = fc.wgt[s][j]; }
  L1Post post;
  bool pok = l1.decodePost(pre, pc.data(), pw.data(), post);
  printf("L1-post %d plps %zu\n", pok, post.plp.size());
  if (pok) for (auto &p : post.plp) printf("  plp %d type %d cod %d mod %d rot %d fec %d blocksMax %d tilLen %d tilType %d | start %d blocks %d\n", p.id, p.type, p.cod, p.mod, p.rot, p.fec, p.blocksMax, p.tilLen, p.tilType, p.start, p.blocks);
  if (pok) {
    T2Stream str; buildStream(fc, pre, str);
    printf("stream cells %zu\n", str.cell.size());
    PlpDecoder dec;
    const PlpCfg &p = post.plp[0];
    if (dec.configure(p)) {
      size_t need = (size_t)p.blocks * dec.fec.ncell;
      printf("plp cells %zu (have %zu)\n", need, str.cell.size() - p.start);
      std::vector<uint8_t> ts;
      dec.decodeFrame(str.cell.data() + p.start, str.w.data() + p.start, p.blocks, ts);
      printf("fec blocks %d ok %d fixed %d fail %d avg iters %.1f, bb frames %llu hdr bad %llu, ts bytes %zu packets %llu\n", dec.st.blocks, dec.st.ok, dec.st.fixed, dec.st.bchFail, dec.st.iters / (double)std::max(1, dec.st.blocks), (unsigned long long)dec.bb.frames, (unsigned long long)dec.bb.crcBad, ts.size(), (unsigned long long)dec.bb.packets);
      FILE *g = fopen("/tmp/out_rx.ts", "wb"); fwrite(ts.data(), 1, ts.size(), g); fclose(g);
    }
  }
  if (getenv("EVMSYM")) {
    static const double L64[8] = {7, 5, 1, 3, -7, -5, -1, -3};
    for (int l = 0; l < (int)fc.cell.size(); l += 6) {
      if (l < NP) { double e = 0; for (int j = 0; j < 1840 / NP; j++) { cf d = fc.cell[l][j] - cf(fc.cell[l][j].real() >= 0 ? 1.f : -1.f, 0); e += cabs2(d); } printf("sym %d (P2) bpsk err %.4f\n", l, e / (1840 / NP)); continue; }
      double e = 0; for (auto &z : fc.cell[l]) { double bi = 1e9, bq = 1e9; for (int a = 0; a < 8; a++) { double v = L64[a] / sqrt(42.0); bi = std::min(bi, fabs(z.real() - v)); bq = std::min(bq, fabs(z.imag() - v)); } e += bi * bi + bq * bq; }
      printf("sym %d evm %.4f\n", l, e / fc.cell[l].size());
    }
  }
  // EVM of the data cells of the first data symbol against 64QAM grid
  {
    const std::vector<cf> &cs = fc.cell[NP + 5]; double e = 0, p = 0;
    static const double L64[8] = {7, 5, 1, 3, -7, -5, -1, -3};
    for (auto &z : cs) { double bi = 1e9, bq = 1e9; for (int a = 0; a < 8; a++) { double v = L64[a] / sqrt(42.0); bi = std::min(bi, fabs(z.real() - v)); bq = std::min(bq, fabs(z.imag() - v)); } e += bi * bi + bq * bq; p += 1; }
    printf("data symbol EVM vs 64QAM grid: %.4f (rms %.4f)\n", e / p, sqrt(e / p));
  }
  return 0;
}
