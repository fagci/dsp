// Development test: P1 -> P2 symbols -> L1-pre on a DVB-T2 baseband capture (complex float32).
#include "t2p1.h"
#include "t2struct_gen.h"
#include "t2freq_gen.h"
#include "ldpc_gen.h"
#include "l1_gen.h"
#include "ldpc.h"
#include <cstdio>
using namespace dvbofdm;
using namespace gr::dtv;

static const int FFT_OF_S2[8] = {2048, 8192, 4096, 1024, 16384, 32768, 8192, 32768};
static const dvbt2_fftsize_t ENUM_OF_S2[8] = {FFTSIZE_2K, FFTSIZE_8K, FFTSIZE_4K, FFTSIZE_1K, FFTSIZE_16K, FFTSIZE_32K, FFTSIZE_8K_T2GI, FFTSIZE_32K_T2GI};
static const double GI_FRAC[7] = {1 / 32., 1 / 16., 1 / 8., 1 / 4., 1 / 128., 19 / 128., 19 / 256.};

static uint32_t crc32bits(const uint8_t *b, int n) {
  uint32_t crc = 0xffffffff;
  for (int i = 0; i < n; i++) { int t = b[i] ^ ((crc >> 31) & 1); crc <<= 1; if (t) crc ^= 0x04C11DB7; }
  return crc;
}

int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb");
  size_t total = 5000000;
  std::vector<cf> x(total + 64);
  size_t got = fread(x.data() + 64, 8, total, f); fclose(f);
  x.resize(got + 64);
  P1 p1;
  float met; int64_t pos = p1.scan(x.data(), (int)std::min<size_t>(x.size(), 1 << 20), 0.3f, &met);
  P1Info pi = p1.identify(x.data(), (int)x.size(), (int)pos, met);
  printf("P1 at %lld ok %d s1 %d s2 %d cfo %.1f Hz\n", (long long)pos, pi.ok, pi.s1, pi.s2, pi.cfo * 9142857.0 / (2 * PI));
  int fftIdx = pi.s2 >> 1, N = FFT_OF_S2[fftIdx];
  bool miso = pi.s1 == 1 || pi.s1 == 4;
  Fft fft(N);
  int64_t p2 = pos + 2048;
  LdpcCode pre; pre.build(16200, 3240, &LDPC_T2_1_4S[0][0], 9, 13);
  for (int gi = 0; gi < 7; gi++) for (int ext = 0; ext < 2; ext++) {
    int G = (int)(N * GI_FRAC[gi] + 0.5);
    T2Struct st(ext ? CARRIERS_EXTENDED : CARRIERS_NORMAL, ENUM_OF_S2[fftIdx], PILOT_PP1, GI_1_32, 1, PAPR_OFF, VERSION_111, miso ? PREAMBLE_T2_MISO : PREAMBLE_T2_SISO, MISO_TX1, EQUALIZATION_OFF, BANDWIDTH_8_0_MHZ, N);
    T2FreqIl fi(ext ? CARRIERS_EXTENDED : CARRIERS_NORMAL, ENUM_OF_S2[fftIdx], PILOT_PP1, GI_1_32, 1, PAPR_OFF, VERSION_111, miso ? PREAMBLE_T2_MISO : PREAMBLE_T2_SISO);
    std::vector<cf> pre1840(1840); std::vector<float> w1840(1840, 0.f);
    std::vector<cf> buf(N);
    for (int s = 0; s < st.N_P2; s++) {
      int64_t start = p2 + (int64_t)s * (N + G);
      int d = G / 2;
      for (int i = 0; i < N; i++) buf[i] = x[start + G - d + i] * cf((float)cos(-pi.cfo * (start + G - d + i)), (float)sin(-pi.cfo * (start + G - d + i)));
      fft.run(buf.data());
      int left = (N - st.C_PS) / 2 + 1;
      std::vector<cf> Y(st.C_PS), H(st.C_PS);
      for (int n = 0; n < st.C_PS; n++) Y[n] = buf[(left + n + N / 2) % N];
      // pilots
      std::vector<int> pn; std::vector<cf> pv;
      for (int n = 0; n < st.C_PS; n++) {
        int t = st.p2_carrier_map[n];
        if (t == P2PILOT_CARRIER || t == P2PILOT_CARRIER_INVERTED) {
          cf pil = (t == P2PILOT_CARRIER ? st.p2_bpsk : st.p2_bpsk_inverted)[st.prbs[n + st.K_OFFSET] ^ st.pn_sequence[s]];
          pn.push_back(n); pv.push_back(Y[n] / pil);
        }
      }
      for (int n = 0; n < st.C_PS; n++) {
        size_t k = std::upper_bound(pn.begin(), pn.end(), n) - pn.begin();
        if (k == 0) H[n] = pv[0];
        else if (k == pn.size()) H[n] = pv.back();
        else { float a = (float)(n - pn[k - 1]) / (pn[k] - pn[k - 1]); H[n] = pv[k - 1] * (1 - a) + pv[k] * a; }
      }
      // data cells in carrier order
      std::vector<cf> cells; std::vector<float> wts;
      for (int n = 0; n < st.C_PS; n++) if (st.p2_carrier_map[n] == DATA_CARRIER) { cells.push_back(Y[n] / H[n]); wts.push_back(cabs2(H[n])); }
      if ((int)cells.size() != st.C_P2) { printf("cell count mismatch %zu vs %d\n", cells.size(), st.C_P2); continue; }
      const int *Hp = (s % 2) == 0 ? fi.HevenP2 : fi.HoddP2;
      std::vector<cf> orig(st.C_P2); std::vector<float> ow(st.C_P2);
      for (int j = 0; j < st.C_P2; j++) { orig[Hp[j]] = cells[j]; ow[Hp[j]] = wts[j]; }
      for (int j = 0; j < 1840 / st.N_P2; j++) { pre1840[s + j * st.N_P2] = orig[j]; w1840[s + j * st.N_P2] = ow[j]; }
    }
    // codeword LLRs
    std::vector<float> llr(16200, 0.f);
    for (int i = 0; i < 200; i++) llr[i] = pre1840[i].real() * w1840[i] * 4;
    for (int i = 200; i < 3072; i++) llr[i] = 30.f;  // zero padding
    for (int i = 0; i < 168; i++) llr[3072 + i] = pre1840[200 + i].real() * w1840[200 + i] * 4;
    std::vector<uint8_t> punct(12960, 0);
    for (int c = 0; c < 31; c++) for (int c2 = 0; c2 < 360; c2++) punct[c2 * 36 + L1_pre_puncture[c]] = 1;
    for (int c2 = 0; c2 < 328; c2++) punct[c2 * 36 + L1_pre_puncture[31]] = 1;
    int k = 368;
    for (int i = 0; i < 12960; i++) if (!punct[i]) { llr[3240 + i] = pre1840[k].real() * w1840[k] * 4; k++; }
    std::vector<uint8_t> bits(16200); int it;
    bool ok = pre.decode(llr.data(), bits.data(), 50, &it);
    uint32_t crc = crc32bits(bits.data(), 200);
    printf("GI %d (%.4f) ext %d: ldpc ok %d iters %d crc residue %08x\n", gi, GI_FRAC[gi], ext, ok, it, crc);
    if (ok && crc == 0) {
      auto bf = [&](int a, int n) { int v = 0; for (int i = 0; i < n; i++) v = v * 2 + bits[a + i]; return v; };
      int o = 0;
      printf("  type %d bwt_ext %d s1 %d s2 %d\n", bf(0, 8), bf(8, 1), bf(9, 3), bf(12, 3)); o = 15;
      printf("  repetition %d gi %d papr %d l1mod %d cod %d fec %d post_size %d info %d pp %d\n", bf(16, 1), bf(17, 3), bf(20, 4), bf(24, 4), bf(28, 2), bf(30, 2), bf(32, 18), bf(50, 18), bf(68, 4));
      printf("  txid %d cell %d net %d sys %d frames %d datasyms %d\n", bf(72, 8), bf(80, 16), bf(96, 16), bf(112, 16), bf(128, 8), bf(136, 12));
      return 0;
    }
  }
  return 1;
}
