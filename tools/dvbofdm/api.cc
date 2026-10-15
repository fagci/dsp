// WebAssembly API of the DVB-T2 receiver. The host writes interleaved float32 IQ (any sample rate >= the channel rate) into the input
// buffer and calls t2_feed(); transport stream bytes and a JSON status come back.
#include "t2rx.h"
#include <cstdio>

using namespace dvbofdm;

namespace {
const size_t IN_CAP = 1u << 18;                 // complex samples per call
float inbuf[IN_CAP * 2];
T2Receiver *rx = nullptr;
std::vector<uint8_t> tsOut;
char json[4096];
double fsIn = 0, fsNom = 0;

// streaming windowed-sinc resampler: out(m) = x(t0 + m * ratio)
struct Resamp {
  double ratio = 1, pos = 0;                    // pos: input index (relative to hist[0]) of the next output sample
  std::vector<cf> hist;
  std::vector<float> tab; int TP = 32, PH = 256;
  void init(double r) {
    ratio = r; pos = 0; hist.clear();
    double cut = r > 1 ? 1.0 / r : 1.0;          // low-pass at the output Nyquist when decimating
    tab.assign((PH + 1) * TP, 0.f);
    for (int p = 0; p <= PH; p++) for (int k = 0; k < TP; k++) {
      double d = (k - (TP / 2 - 1)) - (double)p / PH;
      double x = d * cut;
      double h = fabs(x) < 1e-12 ? 1.0 : sin(PI * x) / (PI * x);
      double w = 0.5 + 0.5 * cos(PI * d / (TP / 2));
      tab[p * TP + k] = (float)(h * w * cut);
    }
  }
  void run(const cf *x, size_t n, std::vector<cf> &out) {
    hist.insert(hist.end(), x, x + n);
    size_t i0;
    while ((i0 = (size_t)floor(pos)) + TP / 2 + 1 < hist.size()) {
      double fr = pos - (double)i0; double pf = fr * PH; int p = (int)pf; float a = (float)(pf - p);
      if (i0 < (size_t)(TP / 2 - 1)) { pos += ratio; out.push_back(cf()); continue; }
      const cf *s = &hist[i0 - (TP / 2 - 1)];
      const float *h0 = &tab[p * TP], *h1 = &tab[(p + 1) * TP];
      float re = 0, im = 0;
      for (int k = 0; k < TP; k++) { float h = h0[k] + a * (h1[k] - h0[k]); re += h * s[k].real(); im += h * s[k].imag(); }
      out.push_back(cf(re, im));
      pos += ratio;
    }
    size_t drop = (size_t)floor(pos) > (size_t)TP ? (size_t)floor(pos) - TP : 0;
    if (drop) { hist.erase(hist.begin(), hist.begin() + drop); pos -= (double)drop; }
  }
} rs;
std::vector<cf> tmp;
}

extern "C" {
__attribute__((export_name("t2_in"))) float *t2_in(void) { return inbuf; }
__attribute__((export_name("t2_in_cap"))) size_t t2_in_cap(void) { return IN_CAP; }

// bwKhz: channel bandwidth 1700, 5000, 6000, 7000, 8000, 10000; plp: -1 first data PLP; input rate in Hz
__attribute__((export_name("t2_init"))) int t2_init(int bwKhz, int plp, double inRate, int mergeCommon) {
  delete rx; rx = new T2Receiver();
  rx->cfg.bwMhz = bwKhz / 1000.0; rx->cfg.plp = plp; rx->cfg.mergeCommon = mergeCommon != 0;
  fsNom = rx->fs0(); fsIn = inRate > 0 ? inRate : fsNom;
  if (fsIn < fsNom * 0.999) return -1;            // not enough bandwidth
  rs.init(fsIn / fsNom);
  tsOut.clear();
  return 0;
}
__attribute__((export_name("t2_feed"))) void t2_feed(size_t n) {
  if (!rx) return;
  const cf *x = reinterpret_cast<const cf *>(inbuf);
  if (fabs(fsIn / fsNom - 1.0) < 1e-6) rx->feed(x, n);
  else { tmp.clear(); rs.run(x, n, tmp); if (!tmp.empty()) rx->feed(tmp.data(), tmp.size()); }
  if (!rx->ts.empty()) { tsOut.insert(tsOut.end(), rx->ts.begin(), rx->ts.end()); rx->ts.clear(); }
}
__attribute__((export_name("t2_ts"))) uint8_t *t2_ts(void) { return tsOut.data(); }
__attribute__((export_name("t2_ts_len"))) size_t t2_ts_len(void) { return tsOut.size(); }
__attribute__((export_name("t2_ts_clear"))) void t2_ts_clear(void) { tsOut.clear(); }
__attribute__((export_name("t2_status"))) const char *t2_status(void) {
  if (!rx) { json[0] = 0; return json; }
  const T2Status &s = rx->st;
  snprintf(json, sizeof json,
    "{\"lock\":%d,\"fecOk\":%d,\"fft\":%d,\"gi\":%d,\"mod\":%d,\"cod\":%d,\"plp\":%d,\"numPlp\":%d,\"pp\":%d,\"ext\":%d,\"rot\":%d,\"long\":%d,"
    "\"snr\":%.1f,\"cfo\":%.1f,\"sfo\":%.1f,\"delay\":%.0f,\"frames\":%llu,\"framesOk\":%llu,\"blocks\":%llu,\"blocksOk\":%llu,\"fixed\":%llu,\"packets\":%llu,\"fs\":%.1f}",
    s.lock, s.fecOk, s.fftSize, s.giIdx, s.mod, s.cod, s.plpId, s.numPlp, s.pp, s.ext, s.rot, s.fecLong, s.snrDb, s.cfoHz, s.sfoPpm, s.delay,
    (unsigned long long)s.frames, (unsigned long long)s.framesOk, (unsigned long long)s.blocks, (unsigned long long)s.blocksOk,
    (unsigned long long)s.blocksFix, (unsigned long long)s.packets, fsNom);
  // list of PLPs
  size_t L = strlen(json); json[L - 1] = 0; L--;
  L += snprintf(json + L, sizeof json - L, ",\"ti\":%d,\"text\":\"%s\",\"plps\":[", s.tiSwap, s.text.c_str());
  for (size_t i = 0; i < s.plps.size() && L + 140 < sizeof json; i++) {
    const PlpCfg &p = s.plps[i];
    L += snprintf(json + L, sizeof json - L, "%s{\"id\":%d,\"type\":%d,\"mod\":%d,\"cod\":%d,\"rot\":%d,\"fec\":%d,\"tilType\":%d,\"til\":%d,\"blocks\":%d,\"group\":%d}", i ? "," : "", p.id, p.type, p.mod, p.cod, p.rot, p.fec, p.tilType, p.tilLen, p.blocks, p.group);
  }
  snprintf(json + L, sizeof json - L, "]}");
  return json;
}
// Exception stubs for libc++ (exceptions are off)
void *__cxa_allocate_exception(size_t) { abort(); }
void __cxa_throw(void *, void *, void (*)(void *)) { abort(); }
}
