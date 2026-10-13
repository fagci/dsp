/* rtl_433 → wasm32 без libc: вывод в консоль отсутствует, форматирование — своё (libc.c) */
#ifndef STUB_STDIO_H
#define STUB_STDIO_H
#include <stddef.h>
#include <stdarg.h>
typedef struct FILE FILE;
extern FILE *stderr, *stdout;
#define fprintf(...) (0)
#define printf(...) (0)
#define fputs(s, f) ((void)0)
#define fputc(c, f) ((void)0)
#define puts(s) ((void)0)
#define putchar(c) ((void)0)
#define fflush(f) ((void)0)
int snprintf(char *s, size_t n, const char *fmt, ...);
int sprintf(char *s, const char *fmt, ...);
int vsnprintf(char *s, size_t n, const char *fmt, va_list ap);
int sscanf(const char *s, const char *fmt, ...);
#define EOF (-1)
#endif
