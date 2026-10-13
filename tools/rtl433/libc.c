/* Минимальная libc для сборки rtl_433 в wasm32 без Emscripten: память, строки, форматирование, время.
   Только то, что нужно декодерам; печати нет. */
#include <stddef.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <math.h>
#include <errno.h>

FILE *stderr, *stdout;
int errno;

/* ---------- память: две арены. Постоянная — пока идёт инициализация, временная сбрасывается после каждой подачи отсчётов ---------- */
#define PERSIST_SIZE (6u << 20)
#define SCRATCH_SIZE (3u << 20)
static uint8_t persist_arena[PERSIST_SIZE] __attribute__((aligned(16)));
static uint8_t scratch_arena[SCRATCH_SIZE] __attribute__((aligned(16)));
static size_t persist_top, scratch_top;
static int use_persist = 1;
void rt_persist(int on) { use_persist = on; }
void rt_scratch_reset(void) { scratch_top = 0; }

void *malloc(size_t n) {
    n = (n + 15) & ~(size_t)15;
    if (use_persist) {
        if (persist_top + n + 16 > PERSIST_SIZE) return 0;
        void *p = persist_arena + persist_top + 16; ((size_t *)p)[-1] = n; persist_top += n + 16; return p;
    }
    if (scratch_top + n + 16 > SCRATCH_SIZE) return 0;
    void *p = scratch_arena + scratch_top + 16; ((size_t *)p)[-1] = n; scratch_top += n + 16; return p;
}
void *calloc(size_t n, size_t m) { void *p = malloc(n * m); if (p) memset(p, 0, n * m); return p; }
void free(void *p) { (void)p; }
void *realloc(void *p, size_t n) {
    if (!p) return malloc(n);
    size_t old = ((size_t *)p)[-1];
    if (n <= old) return p;
    void *q = malloc(n);
    if (q) memcpy(q, p, old);
    return q;
}
void abort(void) { __builtin_trap(); }
void exit(int c) { (void)c; __builtin_trap(); }

/* ---------- строки ---------- */
void *memcpy(void *d, const void *s, size_t n) { uint8_t *a = d; const uint8_t *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n) {
    uint8_t *a = d; const uint8_t *b = s;
    if (a < b) while (n--) *a++ = *b++;
    else { a += n; b += n; while (n--) *--a = *--b; }
    return d;
}
void *memset(void *d, int c, size_t n) { uint8_t *a = d; while (n--) *a++ = (uint8_t)c; return d; }
int memcmp(const void *x, const void *y, size_t n) { const uint8_t *a = x, *b = y; for (; n; n--, a++, b++) if (*a != *b) return *a - *b; return 0; }
void *memchr(const void *s, int c, size_t n) { const uint8_t *a = s; for (; n; n--, a++) if (*a == (uint8_t)c) return (void *)a; return 0; }
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return (uint8_t)*a - (uint8_t)*b; }
int strncmp(const char *a, const char *b, size_t n) { for (; n; n--, a++, b++) { if (*a != *b) return (uint8_t)*a - (uint8_t)*b; if (!*a) return 0; } return 0; }
static int lc(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }
int strcasecmp(const char *a, const char *b) { while (*a && lc(*a) == lc(*b)) { a++; b++; } return lc((uint8_t)*a) - lc((uint8_t)*b); }
int strncasecmp(const char *a, const char *b, size_t n) { for (; n; n--, a++, b++) { if (lc((uint8_t)*a) != lc((uint8_t)*b)) return lc((uint8_t)*a) - lc((uint8_t)*b); if (!*a) return 0; } return 0; }
char *strtok_r(char *s, const char *delim, char **save) {
    if (!s) s = *save;
    while (*s && strchr(delim, *s)) s++;
    if (!*s) { *save = s; return 0; }
    char *t = s; while (*s && !strchr(delim, *s)) s++;
    if (*s) { *s = 0; s++; }
    *save = s; return t;
}
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)); return r; }
char *strncpy(char *d, const char *s, size_t n) { size_t i = 0; for (; i < n && s[i]; i++) d[i] = s[i]; for (; i < n; i++) d[i] = 0; return d; }
char *strcat(char *d, const char *s) { strcpy(d + strlen(d), s); return d; }
char *strncat(char *d, const char *s, size_t n) { char *e = d + strlen(d); size_t i = 0; for (; i < n && s[i]; i++) e[i] = s[i]; e[i] = 0; return d; }
char *strchr(const char *s, int c) { for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
char *strrchr(const char *s, int c) { const char *r = 0; for (;; s++) { if (*s == (char)c) r = s; if (!*s) return (char *)r; } }
char *strstr(const char *h, const char *n) {
    size_t l = strlen(n); if (!l) return (char *)h;
    for (; *h; h++) if (!strncmp(h, n, l)) return (char *)h;
    return 0;
}
char *strdup(const char *s) { size_t n = strlen(s) + 1; char *p = malloc(n); if (p) memcpy(p, s, n); return p; }
char *strerror(int e) { (void)e; return "error"; }
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }
long long llabs(long long x) { return x < 0 ? -x : x; }

/* ---------- числа из строк ---------- */
unsigned long long strtoull(const char *s, char **end, int base) {
    while (*s == ' ' || (*s >= 9 && *s <= 13)) s++;
    int neg = 0;
    if (*s == '-') { neg = 1; s++; } else if (*s == '+') s++;
    if ((base == 0 || base == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) { s += 2; base = 16; }
    else if (base == 0) base = s[0] == '0' ? 8 : 10;
    unsigned long long v = 0; const char *st = s;
    for (;; s++) {
        int d = *s >= '0' && *s <= '9' ? *s - '0' : *s >= 'a' && *s <= 'z' ? *s - 'a' + 10 : *s >= 'A' && *s <= 'Z' ? *s - 'A' + 10 : 99;
        if (d >= base) break;
        v = v * base + d;
    }
    if (end) *end = (char *)(s == st ? (st - 0) : s);
    return neg ? (unsigned long long)(-(long long)v) : v;
}
long long strtoll(const char *s, char **e, int b) { return (long long)strtoull(s, e, b); }
unsigned long strtoul(const char *s, char **e, int b) { return (unsigned long)strtoull(s, e, b); }
long strtol(const char *s, char **e, int b) { return (long)strtoull(s, e, b); }
int atoi(const char *s) { return (int)strtol(s, 0, 10); }
double strtod(const char *s, char **end) {
    while (*s == ' ') s++;
    int neg = 0; if (*s == '-') { neg = 1; s++; } else if (*s == '+') s++;
    double v = 0; while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    if (*s == '.') { s++; double f = .1; while (*s >= '0' && *s <= '9') { v += (*s++ - '0') * f; f /= 10; } }
    if (end) *end = (char *)s;
    return neg ? -v : v;
}
double atof(const char *s) { return strtod(s, 0); }
int sscanf(const char *s, const char *fmt, ...) { (void)s; (void)fmt; return 0; }
void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *)) {
    uint8_t *a = base, tmp[64];
    if (sz > sizeof tmp) return;
    for (size_t i = 1; i < n; i++) {
        memcpy(tmp, a + i * sz, sz);
        size_t j = i;
        while (j > 0 && cmp(a + (j - 1) * sz, tmp) > 0) { memcpy(a + j * sz, a + (j - 1) * sz, sz); j--; }
        memcpy(a + j * sz, tmp, sz);
    }
}

/* ---------- математика, которой нет среди инструкций wasm ---------- */
double round(double x) { return x < 0 ? __builtin_ceil(x - .5) : __builtin_floor(x + .5); }
float roundf(float x) { return (float)round(x); }
long lround(double x) { return (long)round(x); }
long long llround(double x) { return (long long)round(x); }
long lroundf(float x) { return (long)round(x); }
double rint(double x) { return __builtin_rint(x); }
double nearbyint(double x) { return __builtin_rint(x); }
long lrint(double x) { return (long)__builtin_rint(x); }
double fmod(double a, double b) { if (b == 0) return 0; double q = __builtin_trunc(a / b); return a - q * b; }
float fmodf(float a, float b) { return (float)fmod(a, b); }

/* ---------- время (UTC) ---------- */
extern double rt_now_ms(void);                    /* импорт: Date.now() страницы */
time_t time(time_t *t) { time_t v = (time_t)(rt_now_ms() / 1000); if (t) *t = v; return v; }
#include <sys/time.h>
int gettimeofday(struct timeval *tv, void *tz) { (void)tz; double ms = rt_now_ms(); tv->tv_sec = (long long)(ms / 1000); tv->tv_usec = (long)((ms - tv->tv_sec * 1000.0) * 1000); return 0; }
static long long days_from_civil(long long y, unsigned m, unsigned d) {
    y -= m <= 2;
    long long era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (long long)doe - 719468;
}
time_t mktime(struct tm *tm) {
    long long y = tm->tm_year + 1900 + tm->tm_mon / 12; int mon = tm->tm_mon % 12; if (mon < 0) { mon += 12; y--; }
    long long days = days_from_civil(y, mon + 1, 1) + tm->tm_mday - 1;
    return days * 86400 + tm->tm_hour * 3600 + tm->tm_min * 60 + tm->tm_sec;
}
static struct tm gmt_buf;
struct tm *gmtime(const time_t *t) {
    long long s = *t, days = s / 86400, rem = s % 86400;
    if (rem < 0) { rem += 86400; days--; }
    gmt_buf.tm_hour = rem / 3600; gmt_buf.tm_min = rem % 3600 / 60; gmt_buf.tm_sec = rem % 60;
    gmt_buf.tm_wday = (int)((days + 4) % 7 + 7) % 7;
    long long z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long long y = yoe + era * 400; unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
    unsigned d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
    gmt_buf.tm_year = (int)(y + (m <= 2) - 1900); gmt_buf.tm_mon = m - 1; gmt_buf.tm_mday = d; gmt_buf.tm_isdst = 0;
    return &gmt_buf;
}
struct tm *localtime(const time_t *t) { return gmtime(t); }
size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tm) { (void)fmt; (void)tm; if (max) s[0] = 0; return 0; }

/* ---------- vsnprintf ---------- */
typedef struct { char *buf; size_t cap, len; } outb;
static void putc_(outb *o, char c) { if (o->len + 1 < o->cap) o->buf[o->len] = c; o->len++; }
static void pad_(outb *o, char c, int n) { while (n-- > 0) putc_(o, c); }

static int fmt_uint(char *tmp, unsigned long long v, int base, int upper) {
    const char *dg = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    int n = 0; if (!v) tmp[n++] = '0';
    while (v) { tmp[n++] = dg[v % base]; v /= base; }
    return n;
}
/* %f с заданной точностью: целая часть через long long, дробная — умножением на 10 */
static int fmt_fixed(char *out, double x, int prec) {
    int n = 0;
    if (x >= 9.2e18) { out[n++] = '9'; return n; }
    unsigned long long ip = (unsigned long long)x; double fr = x - (double)ip;
    double scale = 1; for (int i = 0; i < prec; i++) scale *= 10;
    unsigned long long fp = (unsigned long long)(fr * scale + .5);
    if ((double)fp >= scale) { ip++; fp = 0; }
    char t[24]; int k = fmt_uint(t, ip, 10, 0); while (k) out[n++] = t[--k];
    if (prec) {
        out[n++] = '.';
        k = fmt_uint(t, fp, 10, 0);
        for (int i = k; i < prec; i++) out[n++] = '0';
        while (k) out[n++] = t[--k];
    }
    return n;
}
static void fmt_double(outb *o, double x, char conv, int prec, int width, int left, int zero, int plus, int space) {
    char tmp[400]; int n = 0, neg = 0;
    if (x != x) { const char *s = "nan"; while (*s) tmp[n++] = *s++; }
    else {
        if (x < 0 || (x == 0 && 1 / x < 0)) { neg = 1; x = -x; }
        if (x > 1e300) { const char *s = "inf"; while (*s) tmp[n++] = *s++; }
        else if (conv == 'f' || conv == 'F') { n = fmt_fixed(tmp, x, prec < 0 ? 6 : prec); }
        else {                                   /* e / g */
            if (prec < 0) prec = 6;
            int ex = 0;
            if (x != 0) { while (x >= 10) { x /= 10; ex++; } while (x < 1) { x *= 10; ex--; } }
            int sig = (conv == 'g' || conv == 'G') ? (prec ? prec : 1) : prec + 1;
            double r = x; for (int i = 1; i < sig; i++) r *= 10;
            unsigned long long m = (unsigned long long)(r + .5);
            unsigned long long lim = 1; for (int i = 0; i < sig; i++) lim *= 10;
            if (m >= lim) { m /= 10; ex++; }
            char dg[24]; int nd = fmt_uint(dg, m, 10, 0);
            while (nd < sig) { for (int i = nd; i > 0; i--) dg[i] = dg[i - 1]; dg[0] = '0'; nd++; }
            char d2[24]; for (int i = 0; i < sig; i++) d2[i] = dg[sig - 1 - i];
            int useE = (conv == 'e' || conv == 'E') || ex < -4 || ex >= sig;
            if (useE) {
                int keep = sig; if (conv == 'g' || conv == 'G') while (keep > 1 && d2[keep - 1] == '0') keep--;
                tmp[n++] = d2[0]; if (keep > 1) { tmp[n++] = '.'; for (int i = 1; i < keep; i++) tmp[n++] = d2[i]; }
                tmp[n++] = conv == 'E' || conv == 'G' ? 'E' : 'e'; tmp[n++] = ex < 0 ? '-' : '+';
                int ae = ex < 0 ? -ex : ex; if (ae < 10) tmp[n++] = '0';
                char t[8]; int k = fmt_uint(t, ae, 10, 0); while (k) tmp[n++] = t[--k];
            } else {
                int keep = sig; if (conv == 'g' || conv == 'G') while (keep > 1 && d2[keep - 1] == '0') keep--;
                if (ex >= 0) {
                    for (int i = 0; i <= ex; i++) tmp[n++] = i < sig ? d2[i] : '0';
                    if (keep > ex + 1) { tmp[n++] = '.'; for (int i = ex + 1; i < keep; i++) tmp[n++] = d2[i]; }
                } else {
                    tmp[n++] = '0'; tmp[n++] = '.'; for (int i = 0; i < -ex - 1; i++) tmp[n++] = '0';
                    for (int i = 0; i < keep; i++) tmp[n++] = d2[i];
                }
            }
        }
    }
    char sign = neg ? '-' : plus ? '+' : space ? ' ' : 0;
    int total = n + (sign ? 1 : 0);
    if (!left && !zero) pad_(o, ' ', width - total);
    if (sign) putc_(o, sign);
    if (!left && zero) pad_(o, '0', width - total);
    for (int i = 0; i < n; i++) putc_(o, tmp[i]);
    if (left) pad_(o, ' ', width - total);
}
int vsnprintf(char *s, size_t cap, const char *f, va_list ap) {
    outb o = {s, cap, 0};
    for (; *f; f++) {
        if (*f != '%') { putc_(&o, *f); continue; }
        f++;
        int left = 0, zero = 0, plus = 0, space = 0, alt = 0, width = 0, prec = -1, lng = 0;
        for (;; f++) { if (*f == '-') left = 1; else if (*f == '0') zero = 1; else if (*f == '+') plus = 1; else if (*f == ' ') space = 1; else if (*f == '#') alt = 1; else break; }
        if (*f == '*') { width = va_arg(ap, int); if (width < 0) { left = 1; width = -width; } f++; }
        else while (*f >= '0' && *f <= '9') width = width * 10 + *f++ - '0';
        if (*f == '.') { f++; prec = 0; if (*f == '*') { prec = va_arg(ap, int); f++; } else while (*f >= '0' && *f <= '9') prec = prec * 10 + *f++ - '0'; }
        for (;; f++) { if (*f == 'l') lng++; else if (*f == 'h' || *f == 'z' || *f == 'j' || *f == 't') { if (*f != 'h') lng = 2; } else break; }
        char c = *f;
        if (c == '%') { putc_(&o, '%'); continue; }
        if (c == 'c') { char ch = (char)va_arg(ap, int); if (!left) pad_(&o, ' ', width - 1); putc_(&o, ch); if (left) pad_(&o, ' ', width - 1); continue; }
        if (c == 's') {
            const char *str = va_arg(ap, const char *); if (!str) str = "(null)";
            int n = 0; while (str[n] && (prec < 0 || n < prec)) n++;
            if (!left) pad_(&o, ' ', width - n);
            for (int i = 0; i < n; i++) putc_(&o, str[i]);
            if (left) pad_(&o, ' ', width - n);
            continue;
        }
        if (c == 'f' || c == 'F' || c == 'e' || c == 'E' || c == 'g' || c == 'G') {
            fmt_double(&o, va_arg(ap, double), c, prec, width, left, zero, plus, space); continue;
        }
        if (c == 'd' || c == 'i' || c == 'u' || c == 'x' || c == 'X' || c == 'o' || c == 'p') {
            unsigned long long v; int neg = 0, base = 10, up = c == 'X';
            if (c == 'd' || c == 'i') {
                long long sv = lng >= 2 ? va_arg(ap, long long) : lng == 1 ? (long long)va_arg(ap, long) : (long long)va_arg(ap, int);
                if (sv < 0) { neg = 1; v = (unsigned long long)(-sv); } else v = (unsigned long long)sv;
            } else {
                v = lng >= 2 ? va_arg(ap, unsigned long long) : lng == 1 ? (unsigned long long)va_arg(ap, unsigned long) : (unsigned long long)va_arg(ap, unsigned);
                if (c == 'x' || c == 'X' || c == 'p') base = 16; else if (c == 'o') base = 8;
            }
            char tmp[24]; int n = fmt_uint(tmp, v, base, up);
            int zp = prec > n ? prec - n : 0;
            char sign = neg ? '-' : (c == 'd' || c == 'i') && plus ? '+' : (c == 'd' || c == 'i') && space ? ' ' : 0;
            int pre = (alt && base == 16 && v) ? 2 : 0;
            int total = n + zp + (sign ? 1 : 0) + pre;
            int zfill = zero && !left && prec < 0 ? (width > total ? width - total : 0) : 0;
            if (!left) pad_(&o, ' ', width - total - zfill);
            if (sign) putc_(&o, sign);
            if (pre) { putc_(&o, '0'); putc_(&o, up ? 'X' : 'x'); }
            pad_(&o, '0', zp + zfill);
            while (n) putc_(&o, tmp[--n]);
            if (left) pad_(&o, ' ', width - total);
            continue;
        }
    }
    if (cap) o.buf[o.len < cap ? o.len : cap - 1] = 0;
    return (int)o.len;
}
int snprintf(char *s, size_t n, const char *f, ...) { va_list ap; va_start(ap, f); int r = vsnprintf(s, n, f, ap); va_end(ap); return r; }
int sprintf(char *s, const char *f, ...) { va_list ap; va_start(ap, f); int r = vsnprintf(s, 1u << 20, f, ap); va_end(ap); return r; }
