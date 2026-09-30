#pragma once
#define NULL ((void*)0)
#define RAND_MAX 2147483647
typedef unsigned long size_t;
void* malloc(size_t);
void* calloc(size_t,size_t);
void free(void*);
int rand(void);
static inline int abs(int x){ return x<0 ? -x : x; }
static inline void exit(int c){ (void)c; __builtin_trap(); }
