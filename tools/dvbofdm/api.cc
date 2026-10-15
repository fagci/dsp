// WebAssembly API of the DVB-T2 receiver. The host writes interleaved float32 IQ (any sample rate >= the channel rate) into the input
// buffer and calls t2_feed(); transport stream bytes and a JSON status come back.
#include "t2rx.h"
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif
#include <cstdio>

using namespace dvbofdm;

namespace {
const size_t IN_CAP = 1u << 18;                 // complex samples per call
float inbuf[IN_CAP * 2];
T2Receiver *rx = nullptr;
std::vector<uint8_t> tsOut;
char json[4096];
double fsIn = 0, fsNom = 0;
uint32_t epochCtr = 0, curEpoch = 0;
std::vector<uint8_t> curJob, resBuf, jobBuf, resOut;     // parallel mode: job popped for the host / result handed in / pool worker side
T2Receiver *wrx = nullptr;

// streaming windowed-sinc resampler: out(m) = x(t0 + m * ratio); fixed-point (Q32) position, 16 taps, 1024 phases
struct Resamp {
  uint64_t pos = 0, step = 0;                   // position of the next output in input samples (relative to hist[0]), Q32
  std::vector<float> hist;                      // interleaved re, im
  std::vector<float> tab; int TP = 16, PH = 1024;
  void init(double r) {
    step = (uint64_t)(r * 4294967296.0 + 0.5);
    double cut = r > 1 ? 1.0 / r : 1.0;          // low-pass at the output Nyquist when decimating
    tab.assign((size_t)(PH + 1) * TP * 2, 0.f);       // every tap twice (re, im) so the loop below is plain SIMD
    for (int p = 0; p <= PH; p++) for (int k = 0; k < TP; k++) {
      double d = (k - (TP / 2 - 1)) - (double)p / PH;
      double x = d * cut;
      double h = fabs(x) < 1e-12 ? 1.0 : sin(PI * x) / (PI * x);
      double w = 0.5 + 0.5 * cos(PI * d / (TP / 2));
      tab[((size_t)p * TP + k) * 2] = tab[((size_t)p * TP + k) * 2 + 1] = (float)(h * w * cut);
    }
    hist.assign((size_t)(TP / 2) * 2, 0.f);       // zeros in front: the first output sits at index TP/2 - 1 + 1
    pos = (uint64_t)(TP / 2) << 32;
  }
  void run(const cf *x, size_t n, std::vector<cf> &out) {
    size_t old = hist.size();
    hist.resize(old + n * 2);
    memcpy(&hist[old], x, n * sizeof(cf));
    const size_t avail = hist.size() / 2;
    size_t maxOut = (size_t)((double)avail / ((double)step / 4294967296.0)) + 8;
    size_t o0 = out.size();
    out.resize(o0 + maxOut);
    float *o = reinterpret_cast<float *>(&out[o0]);
    size_t cnt = 0;
    const float *H = hist.data(), *T = tab.data();
    uint64_t ps = pos;
    for (;;) {
      size_t i0 = (size_t)(ps >> 32);
      if (i0 + TP / 2 + 1 >= avail) break;
      int p = (int)((((uint32_t)ps) + (1u << 21)) >> 22);             // nearest of 1024 phases (can be 1024)
      const float *s = H + 2 * (i0 - (TP / 2 - 1));
      const float *h0 = T + (size_t)p * TP * 2;
#ifdef __wasm_simd128__
      v128_t acc = wasm_f32x4_splat(0.f);
      for (int j = 0; j < TP * 2; j += 4) acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(h0 + j), wasm_v128_load(s + j)));
      o[2 * cnt] = wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 2);
      o[2 * cnt + 1] = wasm_f32x4_extract_lane(acc, 1) + wasm_f32x4_extract_lane(acc, 3);
#else
      float a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (int j = 0; j < TP * 2; j += 4) { a0 += h0[j] * s[j]; a1 += h0[j + 1] * s[j + 1]; a2 += h0[j + 2] * s[j + 2]; a3 += h0[j + 3] * s[j + 3]; }
      o[2 * cnt] = a0 + a2; o[2 * cnt + 1] = a1 + a3;
#endif
      cnt++; ps += step;
    }
    out.resize(o0 + cnt);
    pos = ps;
    size_t i0 = (size_t)(pos >> 32);
    if (i0 > (size_t)TP * 2) {
      size_t drop = i0 - TP;
      hist.erase(hist.begin(), hist.begin() + drop * 2);
      pos -= (uint64_t)drop << 32;
    }
  }
} rs;
std::vector<cf> tmp;
void drainTs() { if (rx && !rx->ts.empty()) { tsOut.insert(tsOut.end(), rx->ts.begin(), rx->ts.end()); rx->ts.clear(); } }
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
  drainTs();
}
__attribute__((export_name("t2_gap"))) void t2_gap(void) { if (rx) rx->gap(); rs.init(fsIn / fsNom); }

// ---- frame level parallelism (see T2Receiver::setParallel). Receiver side:
__attribute__((export_name("t2_par"))) uint32_t t2_par(int on) { if (!rx) return 0; curEpoch = ++epochCtr; rx->setParallel(on != 0, curEpoch); return curEpoch; }
__attribute__((export_name("t2_serial"))) int t2_serial(void) { return rx && rx->serial() ? 1 : 0; }
// takes the next job: returns its size (0: none); the bytes are at t2_job_ptr() until the next call
__attribute__((export_name("t2_job_pop"))) size_t t2_job_pop(void) {
  if (!rx || rx->jobsOut.empty()) return 0;
  curJob = std::move(rx->jobsOut.front()); rx->jobsOut.erase(rx->jobsOut.begin());
  return curJob.size();
}
__attribute__((export_name("t2_job_ptr"))) uint8_t *t2_job_ptr(void) { return curJob.data(); }
__attribute__((export_name("t2_job_seq"))) uint32_t t2_job_seq(void) { uint32_t q = 0; if (curJob.size() >= 12) memcpy(&q, curJob.data() + 8, 4); return q; }
__attribute__((export_name("t2_alloc"))) uint8_t *t2_alloc(size_t n) { resBuf.resize(n); return resBuf.data(); }
__attribute__((export_name("t2_result"))) void t2_result(size_t n) { if (!rx) return; rx->result(resBuf.data(), n); drainTs(); resBuf.clear(); resBuf.shrink_to_fit(); }
__attribute__((export_name("t2_drop"))) void t2_drop(uint32_t seq) { if (!rx) return; std::vector<uint8_t> b; T2Receiver::dropResult(curEpoch, seq, b); rx->result(b.data(), b.size()); drainTs(); }
// pool worker side:
__attribute__((export_name("t2w_init"))) void t2w_init(void) { if (!wrx) wrx = new T2Receiver(); }
__attribute__((export_name("t2w_alloc"))) uint8_t *t2w_alloc(size_t n) { jobBuf.resize(n); return jobBuf.data(); }
__attribute__((export_name("t2w_run"))) size_t t2w_run(size_t n) {
  if (!wrx) return 0;
  wrx->runJob(jobBuf.data(), n, resOut);
  jobBuf.clear(); jobBuf.shrink_to_fit();
  return resOut.size();
}
__attribute__((export_name("t2w_out"))) uint8_t *t2w_out(void) { return resOut.data(); }
__attribute__((export_name("t2w_free"))) void t2w_free(void) { resOut.clear(); resOut.shrink_to_fit(); }
__attribute__((export_name("t2_ts"))) uint8_t *t2_ts(void) { return tsOut.data(); }
__attribute__((export_name("t2_ts_len"))) size_t t2_ts_len(void) { return tsOut.size(); }
__attribute__((export_name("t2_ts_clear"))) void t2_ts_clear(void) { tsOut.clear(); }
__attribute__((export_name("t2_status"))) const char *t2_status(void) {
  if (!rx) { json[0] = 0; return json; }
  const T2Status &s = rx->st;
  snprintf(json, sizeof json,
    "{\"lock\":%d,\"fecOk\":%d,\"fft\":%d,\"gi\":%d,\"mod\":%d,\"cod\":%d,\"plp\":%d,\"numPlp\":%d,\"pp\":%d,\"ext\":%d,\"rot\":%d,\"long\":%d,"
    "\"p1ok\":%llu,\"p1bad\":%llu,\"preBad\":%llu,\"met\":%.2f,\"ids\":%.2f,\"s1\":%d,\"s2\":%d,\"preSnr\":%.1f,\"preGi\":%d,\"preExt\":%d,\"prePapr\":%d,\"snr\":%.1f,\"cfo\":%.1f,\"sfo\":%.1f,\"delay\":%.0f,\"frames\":%llu,\"framesOk\":%llu,\"blocks\":%llu,\"blocksOk\":%llu,\"fixed\":%llu,\"packets\":%llu,\"fs\":%.1f}",
    s.lock, s.fecOk, s.fftSize, s.giIdx, s.mod, s.cod, s.plpId, s.numPlp, s.pp, s.ext, s.rot, s.fecLong, (unsigned long long)s.p1ok, (unsigned long long)s.p1bad, (unsigned long long)s.preBad, s.metric, s.idScore, s.s1, s.s2, s.preSnr, s.preGi, s.preExt, s.prePapr, s.snrDb, s.cfoHz, s.sfoPpm, s.delay,
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
