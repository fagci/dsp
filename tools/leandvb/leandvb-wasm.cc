// leandvb (LeanSDR) как WebAssembly: DVB-S / DVB-S2 из IQ в транспортный поток.
// Включает исходник leandvb.cc (после leandvb-wasm.patch) с main → leandvb_main. Ввод-вывод — через подменённые read/write:
// fd 0 — вход (IQ), fd 1 — TS, fd 3 — строки состояния (--fd-info 3). Планировщик шагается из lds_feed().
#include <stdint.h>
#include <stddef.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

#define main leandvb_main
#include "leandvb.cc"
#undef main

namespace {
const size_t IN_CAP = 1u << 20, OUT_CAP = 1u << 20, INFO_CAP = 16384;
uint8_t inbuf[IN_CAP], outbuf[OUT_CAP];
char infobuf[INFO_CAP];
size_t in_pos, in_len, out_len, info_len;
uint32_t out_drop, in_drop;
char cmd[1024];
const char *argv_[64];
}

extern "C" {
// libc++ тянет throw из operator new; исключения выключены
void *__cxa_allocate_exception(size_t) { abort(); }
void __cxa_throw(void *, void *, void (*)(void *)) { abort(); }
ssize_t read(int fd, void *buf, size_t n) {
  if (fd != 0) { errno = EBADF; return -1; }
  size_t k = in_len - in_pos; if (k > n) k = n;
  memcpy(buf, inbuf + in_pos, k); in_pos += k;
  return (ssize_t)k;
}
ssize_t write(int fd, const void *buf, size_t n) {
  if (fd == 1) {
    if (out_len + n > OUT_CAP) { out_drop += n; return (ssize_t)n; }
    memcpy(outbuf + out_len, buf, n); out_len += n;
  } else if (fd == 3) {
    if (info_len + n > INFO_CAP) info_len = 0;
    memcpy(infobuf + info_len, buf, n); info_len += n;
  }
  return (ssize_t)n;
}

__attribute__((export_name("lds_init"))) int lds_init(const char *line) {
  strncpy(cmd, line, sizeof cmd - 1);
  int argc = 0; argv_[argc++] = "leandvb";
  for (char *p = cmd; *p && argc < 63;) {
    while (*p == ' ') *p++ = 0;
    if (!*p) break;
    argv_[argc++] = p;
    while (*p && *p != ' ') ++p;
  }
  in_pos = in_len = out_len = info_len = 0; out_drop = in_drop = 0;
  return leandvb_main(argc, argv_);
}
__attribute__((export_name("lds_in"))) uint8_t *lds_in(void) { return inbuf; }
__attribute__((export_name("lds_in_cap"))) size_t lds_in_cap(void) { return IN_CAP; }
// n байт во входном буфере → прогон планировщика; возвращает число байт, которые не вошли
__attribute__((export_name("lds_feed"))) size_t lds_feed(size_t n) {
  in_pos = 0; in_len = n;
  unsigned long long prev = ~0ull;
  while (in_pos < in_len) {
    g_sch->step();
    unsigned long long h = g_sch->hash();
    if (h == prev && in_pos < in_len) { in_drop += in_len - in_pos; break; }
    prev = h;
  }
  g_sch->run();
  size_t lost = in_len - in_pos; in_pos = in_len = 0; return lost;
}
__attribute__((export_name("lds_out"))) uint8_t *lds_out(void) { return outbuf; }
__attribute__((export_name("lds_out_len"))) size_t lds_out_len(void) { return out_len; }
__attribute__((export_name("lds_out_clear"))) void lds_out_clear(void) { out_len = 0; }
__attribute__((export_name("lds_out_drop"))) uint32_t lds_out_drop(void) { return out_drop; }
__attribute__((export_name("lds_info"))) char *lds_info(void) { return infobuf; }
__attribute__((export_name("lds_info_len"))) size_t lds_info_len(void) { return info_len; }
__attribute__((export_name("lds_info_clear"))) void lds_info_clear(void) { info_len = 0; }
}
