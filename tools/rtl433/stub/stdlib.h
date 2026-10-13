#ifndef STUB_STDLIB_H
#define STUB_STDLIB_H
#include <stddef.h>
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 32767
void *malloc(size_t n);
void *calloc(size_t n, size_t m);
void *realloc(void *p, size_t n);
void free(void *p);
int abs(int x);
long labs(long x);
long long llabs(long long x);
long strtol(const char *s, char **end, int base);
unsigned long strtoul(const char *s, char **end, int base);
long long strtoll(const char *s, char **end, int base);
unsigned long long strtoull(const char *s, char **end, int base);
double strtod(const char *s, char **end);
int atoi(const char *s);
double atof(const char *s);
void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *));
void exit(int code);
void abort(void);
#endif
